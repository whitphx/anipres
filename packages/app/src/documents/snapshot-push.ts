import type { TLStoreSnapshot } from "tldraw";

/**
 * Push a snapshot to a document's Durable Object room. Used by the
 * migration and reconnect-fork flows, both of which have a real
 * snapshot to land. A successful push also clears the server-side
 * `initializing_at` flag, finalizing the doc.
 *
 * The fresh-create flow does NOT use this — it finalizes via
 * `finalizeSyncedDocument` instead, since synthesizing a valid empty
 * TLStoreSnapshot client-side requires reconstructing tldraw's
 * schema descriptor and would also pre-seed the DO room with empty
 * state, pre-empting useSync's natural "populate on first connect"
 * path.
 */
export async function pushSnapshot(
  documentId: string,
  snapshot: TLStoreSnapshot,
  expectedSnapshotVersion: number,
): Promise<void> {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, expectedSnapshotVersion }),
    },
  );
  if (!res.ok) {
    throw new Error(`Snapshot push failed: ${res.status}`);
  }
}

/**
 * Finalize a fresh synced document so it becomes visible to the user.
 * After `POST /api/documents` the row is marked `initializing_at` on
 * the server; this endpoint clears the flag without touching the DO.
 * The room stays un-seeded until the user opens the doc, at which
 * point useSync populates it on first connect.
 */
export async function finalizeSyncedDocument(
  documentId: string,
): Promise<void> {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/finalize`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`Document finalize failed: ${res.status}`);
  }
}
