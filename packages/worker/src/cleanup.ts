import type { Env } from "./types";

// Grace window between a doc's INSERT and its finalizing snapshot push.
// A row whose `initializing_at` is older than this is treated as
// abandoned and either reconciled (if the DO actually has a snapshot)
// or hard-deleted by the sweep. 10 minutes is generous enough to
// absorb a slow asset upload + snapshot push (the largest step is
// asset transfer for a migrated doc with embedded media).
const INITIALIZING_GRACE_MS = 10 * 60 * 1000;

// Cap the number of rows the sweep handles per run so a backlog can't
// pin a long-running scheduled invocation. The cron fires every five
// minutes, so successive runs drain anything left behind.
const SWEEP_BATCH_LIMIT = 1000;

/**
 * Reconcile or hard-delete documents whose `initializing_at` flag has
 * been set for longer than the grace window. Two outcomes per row:
 *
 * - **Reconcile.** The DO already holds a snapshot (snapshotVersion > 0),
 *   meaning the previous snapshot push succeeded on the DO side but
 *   the follow-up D1 UPDATE that should have cleared `initializing_at`
 *   never landed. The doc is genuinely finalized; the flag is stale.
 *   Clear it so the doc becomes visible again. No data loss.
 *
 * - **Delete.** The DO has no snapshot (snapshotVersion === 0), which
 *   means the client's create flow gave up before the snapshot push
 *   ever reached the DO. The row is a real abandonment; hard-delete it
 *   and let the FK cascade clean up the assets table.
 *
 * Runs from the worker's `scheduled` handler. Idempotent and safe to
 * run concurrently — both paths gate on `initializing_at IS NOT NULL`
 * so a snapshot push that races with us simply pre-empts the
 * reconciliation (it does the same UPDATE we would).
 */
export async function sweepInitializingDocuments(env: Env): Promise<{
  reconciledCount: number;
  deletedCount: number;
}> {
  const cutoff = Date.now() - INITIALIZING_GRACE_MS;
  const candidates = await env.DB.prepare(
    `SELECT id FROM documents
      WHERE initializing_at IS NOT NULL
        AND initializing_at < ?
      LIMIT ?`,
  )
    .bind(cutoff, SWEEP_BATCH_LIMIT)
    .all<{ id: number }>();

  let reconciledCount = 0;
  let deletedCount = 0;

  for (const { id } of candidates.results) {
    const room = env.DOCUMENT_SYNC_ROOM.getByName(String(id));
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
      // delete the row; FK cascade removes the assets table rows.
      const result = await env.DB.prepare(
        `DELETE FROM documents
          WHERE id = ? AND initializing_at IS NOT NULL`,
      )
        .bind(id)
        .run();
      if ((result.meta.changes ?? 0) > 0) {
        deletedCount += 1;
      }
    }
  }

  return { reconciledCount, deletedCount };
}
