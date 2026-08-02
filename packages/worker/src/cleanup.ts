import type { Env } from "./types";
import { scheduleDocumentDeletion } from "./tldraw-assets";

// Grace window between a doc's INSERT and its finalizing snapshot
// push. A row older than this is treated as abandoned and either
// reconciled or deleted. Sized with headroom for a slow asset
// upload followed by the finalizing snapshot push.
const INITIALIZING_GRACE_MS = 10 * 60 * 1000;

// Cap the rows handled per run so a backlog can't pin a long-running
// scheduled invocation; successive runs drain anything left behind.
const SWEEP_BATCH_LIMIT = 1000;

/**
 * Reconcile or delete documents whose `initializing_at` flag has been
 * set for longer than the grace window. Two cases: if the DO already
 * holds a snapshot, the previous push succeeded on the DO but the
 * follow-up D1 UPDATE never landed, so we just clear the stale flag
 * (no data loss); if the DO has nothing, the create flow gave up
 * before the push ever reached it, so we move the row into the
 * `deleting_at` deletion lifecycle. Not a hard DELETE: the FK cascade
 * would only remove the asset ROWS, while R2 objects uploaded by the
 * abandoned attempt need the retryable, DO-driven prefix sweep that
 * the lifecycle owns (`finalizeDeletingDocument` removes the row once
 * the prefix is empty).
 *
 * Idempotent and safe to run concurrently — both paths gate on
 * `initializing_at IS NOT NULL` (the delete path additionally on
 * `deleting_at IS NULL`), so a snapshot push that races with us simply
 * pre-empts the reconciliation (it does the same UPDATE we would).
 */
export async function sweepInitializingDocuments(env: Env): Promise<{
  reconciledCount: number;
  deletedCount: number;
}> {
  const cutoff = Date.now() - INITIALIZING_GRACE_MS;
  // Rows already in the deletion lifecycle are excluded: their DO alarm
  // loop owns them from here (including retries).
  const candidates = await env.DB.prepare(
    `SELECT id FROM documents
      WHERE initializing_at IS NOT NULL
        AND initializing_at < ?
        AND deleting_at IS NULL
      LIMIT ?`,
  )
    .bind(cutoff, SWEEP_BATCH_LIMIT)
    .all<{ id: string }>();

  let reconciledCount = 0;
  let deletedCount = 0;

  for (const { id } of candidates.results) {
    const room = env.DOCUMENT_SYNC_ROOM.getByName(id);
    let snapshotVersion = 0;
    try {
      snapshotVersion = await room.peekSnapshotVersion();
    } catch (error) {
      // A peek failure is not fatal: skip this row, the next sweep
      // will try again. Logging surfaces persistent issues.
      console.error(
        `[sweep] peekSnapshotVersion failed for doc ${id}, skipping:`,
        error,
      );
      continue;
    }

    if (snapshotVersion > 0) {
      // DO has a snapshot — the snapshot-push handler's D1 UPDATE
      // never landed last time. Clear the flag instead of deleting.
      // The `IS NOT NULL` guard makes the UPDATE a no-op if a
      // concurrent push already cleared it.
      const result = await env.DB.prepare(
        `UPDATE documents
            SET initializing_at = NULL
          WHERE id = ? AND initializing_at IS NOT NULL`,
      )
        .bind(id)
        .run();
      if ((result.meta.changes ?? 0) > 0) {
        reconciledCount += 1;
      }
    } else {
      // No snapshot ever landed on the DO. Genuinely abandoned —
      // enter the deletion lifecycle. The guards make this a no-op if
      // a concurrent push finalized the row or another sweep/cancel
      // already claimed it.
      const result = await env.DB.prepare(
        `UPDATE documents
            SET deleting_at = ?
          WHERE id = ?
            AND initializing_at IS NOT NULL
            AND deleting_at IS NULL`,
      )
        .bind(Date.now(), id)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        continue;
      }
      try {
        await scheduleDocumentDeletion(env, id);
      } catch (error) {
        // Revert so the next sweep retries the whole transition; a row
        // stuck in `deleting_at` would have no retry driver.
        await env.DB.prepare(
          `UPDATE documents
              SET deleting_at = NULL
            WHERE id = ? AND deleting_at IS NOT NULL`,
        )
          .bind(id)
          .run();
        console.error(
          `[sweep] failed to schedule deletion for doc ${id}, will retry:`,
          error,
        );
        continue;
      }
      deletedCount += 1;
    }
  }

  return { reconciledCount, deletedCount };
}
