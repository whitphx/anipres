import { apiClient } from "../lib/api-client";

// Snapshot pushes go through migration.ts's `defaultPushSnapshot`
// (injectable per flow). The fresh-create flow instead finalizes via
// `finalizeSyncedDocument`: synthesizing a valid empty TLStoreSnapshot
// client-side would require reconstructing tldraw's schema descriptor,
// and pre-seeding the DO room with empty state would pre-empt useSync's
// natural "populate on first connect" path.

/**
 * Finalize a fresh synced document so it becomes visible to the user.
 * After `PUT /api/documents/:id` the row is marked `initializing_at`
 * on the server; this endpoint clears the flag without touching the
 * DO. The room stays un-seeded until the user opens the doc, at which
 * point useSync populates it on first connect.
 *
 * Failure semantics: if `repo.save` succeeds but this call throws,
 * the row exists on the server with `initializing_at` still set. It
 * stays invisible to the user (the active-list query filters out
 * `initializing_at IS NOT NULL` rows) and the server-side sweep
 * eventually reaps it. The user's natural recovery is to retry, which
 * is just a fresh insert under a new id — no client cleanup is
 * needed because the row was never user-visible.
 */
export async function finalizeSyncedDocument(
  documentId: string,
): Promise<void> {
  const res = await apiClient.api.documents[":id"].finalize.$post({
    param: { id: documentId },
  });
  if (!res.ok) {
    throw new Error(`Document finalize failed: ${res.status}`);
  }
}
