import type { Env } from "./types";

// Grace window between a doc's INSERT and its finalizing snapshot push.
// A row whose `initializing_at` is older than this is treated as
// abandoned and hard-deleted by the sweep. 10 minutes is generous
// enough to absorb a slow asset upload + snapshot push (the largest
// step is asset transfer for a migrated doc with embedded media).
const INITIALIZING_GRACE_MS = 10 * 60 * 1000;

// Cap the number of rows the sweep handles per run so a backlog can't
// pin a long-running scheduled invocation. The cron fires every five
// minutes, so successive runs drain anything left behind.
const SWEEP_BATCH_LIMIT = 1000;

/**
 * Hard-delete documents that started initializing more than the grace
 * window ago and never completed. The associated assets are removed
 * automatically via `assets.document_id ON DELETE CASCADE`; the DO
 * room (if it was even created) will be GC'd by Cloudflare once no
 * references remain.
 *
 * Runs from the worker's `scheduled` handler. Idempotent and safe to
 * run concurrently — the WHERE clause re-checks each row's
 * initializing state.
 */
export async function sweepInitializingDocuments(env: Env): Promise<{
  deletedCount: number;
}> {
  const cutoff = Date.now() - INITIALIZING_GRACE_MS;
  const result = await env.DB.prepare(
    `DELETE FROM documents
     WHERE id IN (
       SELECT id FROM documents
        WHERE initializing_at IS NOT NULL
          AND initializing_at < ?
        LIMIT ?
     )`,
  )
    .bind(cutoff, SWEEP_BATCH_LIMIT)
    .run();
  return { deletedCount: result.meta.changes ?? 0 };
}
