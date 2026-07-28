import type { TLStoreSnapshot } from "tldraw";
import { MINIMUM_SYNC_ANIMATION_DATA_VERSION } from "anipres-worker/animation-data-version";
import { apiClient } from "../lib/api-client";

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
  const res = await apiClient.api.documents[":id"].snapshot.$put(
    {
      param: { id: documentId },
      // `snapshot` is `TLStoreSnapshot`; the route's schema infers
      // `Record<string, unknown>`. Structurally compatible (an object
      // with string keys) but `StoreSnapshot` lacks the explicit string
      // index signature TS needs to widen automatically. Cast is safe —
      // the runtime validator only asserts "is a record".
      json: {
        snapshot: snapshot as unknown as Record<string, unknown>,
        expectedSnapshotVersion,
      },
    },
    {
      init: {
        headers: {
          "x-anipres-animation-data-version": String(
            MINIMUM_SYNC_ANIMATION_DATA_VERSION,
          ),
        },
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Snapshot push failed: ${res.status}`);
  }
}

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
