import type { TLStoreSnapshot } from "tldraw";

/**
 * Push a snapshot to a document's Durable Object room. Used as the
 * finalizing step of a multi-step doc creation:
 *
 *   POST /api/documents             → row inserted (initializing_at = now)
 *   (assets, optional)
 *   PUT /api/documents/:id/snapshot → DO seeded, initializing_at cleared
 *
 * For a freshly-created synced doc with no content yet, callers pass
 * an empty snapshot. Migration and reconnect-fork flows push their own
 * real snapshots via their own logic; this helper exists for callers
 * who only need the contract-completing push.
 *
 * `expectedSnapshotVersion: 0` is the canonical "this is the first
 * snapshot for the doc" value — the server's snapshot push handler
 * rejects with 409 if the DO room already has a snapshot at a
 * different version.
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

// An empty TLStoreSnapshot used as the initial push for synced docs
// created via `createDocument`. The DO room is seeded with no records;
// useSync will populate it once the user starts editing.
export const EMPTY_SNAPSHOT = {
  store: {},
  schema: {},
} as unknown as TLStoreSnapshot;
