import type { TLStoreSnapshot } from "tldraw";
import { REQUIRED_SYNC_ANIMATION_DATA_VERSION } from "anipres-worker/animation-data-version";
import { apiClient } from "../lib/api-client";

// The single client for `PUT /api/documents/:id/snapshot`. Every
// snapshot-replacement flow (local-to-synced migration, offline
// reconnect, reconnect retry, offline-copy fork) goes through
// `putSnapshot` — the worker's animation-data version gate rejects any
// request that does not declare the version header, so an independent
// `$put()` call site is a latent 426.
//
// The fresh-create flow instead finalizes via `finalizeSyncedDocument`:
// synthesizing a valid empty TLStoreSnapshot client-side would require
// reconstructing tldraw's schema descriptor, and pre-seeding the DO
// room with empty state would pre-empt useSync's natural "populate on
// first connect" path.

export interface PutSnapshotParams {
  documentId: string;
  snapshot: TLStoreSnapshot;
  expectedSnapshotVersion: number;
  signal?: AbortSignal;
}

export type PutSnapshotResult =
  | { outcome: "success" }
  | {
      outcome: "conflict";
      status: 409;
      reason: "active-session" | "version-conflict" | null;
    }
  /** HTTP 426: the animation-data version gate rejected this bundle. */
  | { outcome: "client-too-old"; status: 426 }
  | { outcome: "failed"; status: number };

export async function putSnapshot(
  params: PutSnapshotParams,
): Promise<PutSnapshotResult> {
  const { documentId, snapshot, expectedSnapshotVersion, signal } = params;
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
      // The header must ride the client's `headers` option, NOT
      // `init.headers`: hono spreads `init` last, so `init.headers`
      // would REPLACE the computed headers — silently dropping
      // `Content-Type: application/json` (the worker's json validator
      // then rejects the body with 400) and the client-id header.
      headers: {
        "x-anipres-animation-data-version": String(
          REQUIRED_SYNC_ANIMATION_DATA_VERSION,
        ),
      },
      init: { signal },
    },
  );
  if (res.ok) {
    return { outcome: "success" };
  }
  // The gate responds outside the route's typed status set, so widen.
  const status: number = res.status;
  if (status === 426) {
    return { outcome: "client-too-old", status };
  }
  if (status === 409) {
    const body = (await res.json().catch(() => null)) as {
      reason?: "active-session" | "version-conflict";
    } | null;
    return { outcome: "conflict", status, reason: body?.reason ?? null };
  }
  return { outcome: "failed", status };
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
