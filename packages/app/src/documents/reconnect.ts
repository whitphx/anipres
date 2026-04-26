import { generateKeyBetween } from "fractional-indexing";
import type { TLStoreSnapshot } from "tldraw";
import type { ApiDocumentRepository } from "./api-repository";
import {
  snapshotsEqual,
  shouldSkipReconnect,
  type ReconnectSnapshotState,
} from "./offline-recovery";

export type ReconnectResult =
  | { action: "noop" }
  | { action: "pushed" }
  | { action: "forked"; forkedDocumentId: string }
  | {
      action: "error";
      reason: string;
      reasonCode?: "active-session" | "other";
    };

async function fetchOfflineCache(documentId: string): Promise<{
  snapshot: TLStoreSnapshot;
  snapshotVersion: number;
}> {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/offline-cache`,
  );
  if (!res.ok) {
    throw new Error(`Offline cache fetch failed: ${res.status}`);
  }
  return (await res.json()) as {
    snapshot: TLStoreSnapshot;
    snapshotVersion: number;
  };
}

export async function reconcileOfflineEdits(params: {
  documentId: string;
  localSnapshot: TLStoreSnapshot;
  recovery: ReconnectSnapshotState;
  snapshotVersion: number;
  repository: ApiDocumentRepository;
}): Promise<ReconnectResult> {
  const { documentId, localSnapshot, recovery, snapshotVersion, repository } =
    params;

  // Fetch current server metadata before deciding whether to fork on conflict.
  // Running this before shouldSkipReconnect ensures a remotely-deleted document
  // surfaces as an error instead of being silently treated as successful.
  const serverDoc = await repository.get(documentId);
  if (!serverDoc) {
    return {
      action: "error",
      reason: "Document no longer exists on server",
      reasonCode: "other",
    };
  }

  if (shouldSkipReconnect({ snapshot: localSnapshot, recovery })) {
    return { action: "noop" };
  }

  // Try to push: the server endpoint rejects with 409 if the DO snapshot
  // version has advanced since this cached snapshot was written.
  const pushRes = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot: localSnapshot,
        expectedSnapshotVersion: snapshotVersion,
      }),
    },
  );

  if (pushRes.ok) {
    return { action: "pushed" };
  }

  if (pushRes.status !== 409) {
    return {
      action: "error",
      reason: `Snapshot push failed: ${pushRes.status}`,
      reasonCode: "other",
    };
  }

  const conflictBody = (await pushRes.json().catch(() => null)) as {
    reason?: "active-session" | "version-conflict";
  } | null;
  if (conflictBody?.reason === "active-session") {
    return {
      action: "error",
      reason: "Document is still open in another session",
      reasonCode: "active-session",
    };
  }

  // The cached version can lag behind if the document changed locally just
  // before disconnect and the server persisted the same snapshot under a newer
  // revision. Treat identical content as already synced instead of forking.
  try {
    const serverCache = await fetchOfflineCache(documentId);
    if (snapshotsEqual(serverCache.snapshot, localSnapshot)) {
      return { action: "pushed" };
    }

    // If the cached revision lagged behind but the server still matches the
    // last known online baseline, reuse the current server revision instead of
    // forking a document that has not actually diverged.
    if (
      snapshotsEqual(serverCache.snapshot, recovery.baselineSnapshot) ||
      snapshotsEqual(serverCache.snapshot, recovery.reconnectSnapshot)
    ) {
      const retryPushRes = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}/snapshot`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snapshot: localSnapshot,
            expectedSnapshotVersion: serverCache.snapshotVersion,
          }),
        },
      );

      if (retryPushRes.ok) {
        return { action: "pushed" };
      }

      if (retryPushRes.status === 409) {
        const retryConflictBody = (await retryPushRes
          .json()
          .catch(() => null)) as {
          reason?: "active-session" | "version-conflict";
        } | null;
        if (retryConflictBody?.reason === "active-session") {
          return {
            action: "error",
            reason: "Document is still open in another session",
            reasonCode: "active-session",
          };
        }
      } else {
        return {
          action: "error",
          reason: `Snapshot retry failed: ${retryPushRes.status}`,
          reasonCode: "other",
        };
      }
    }
  } catch (error) {
    console.error("Failed to compare server snapshot after conflict:", error);
  }

  // No pending offline edits: let live sync pick up the server state instead
  // of creating a redundant "(offline copy)" fork.
  if (!recovery.hasPendingOfflineChanges) {
    return { action: "noop" };
  }

  // Server has diverged — fork the local version as a new document.
  const originalTitle = serverDoc.meta.title;
  const forkTitle = `${originalTitle} (offline copy)`;
  const now = Date.now();

  // Create the fork on the server. The fork is a distinct document
  // with its own id — we know that id only after the POST response
  // (the API repo ignores any client-supplied id and the server
  // allocates an INTEGER). Place the fork's sort_order right after
  // the original via fractional-indexing — the result is strictly
  // > the original key, which is enough to sit "after" it even if
  // other docs sit further along.
  const forkSortOrder = generateKeyBetween(serverDoc.meta.sortOrder, null);
  const created = await repository.create({
    meta: {
      // Placeholder — the API repo ignores this and the server
      // allocates the real id. Kept as a fresh UUID rather than
      // reusing `documentId` so it doesn't read as "saving the fork
      // under the original's id."
      id: crypto.randomUUID(),
      title: forkTitle,
      createdAt: now,
      updatedAt: now,
      sortOrder: forkSortOrder,
      origin: "synced",
    },
    snapshot: null,
  });
  const forkId = created.meta.id;

  // Push the local snapshot into the fork's Durable Object room.
  let forkPushRes: Response;
  try {
    forkPushRes = await fetch(
      `/api/documents/${encodeURIComponent(forkId)}/snapshot`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshot: localSnapshot,
          expectedSnapshotVersion: 0,
        }),
      },
    );
  } catch (error) {
    await repository.delete(forkId).catch(() => {});
    return {
      action: "error",
      reason: `Failed to push snapshot to forked document: ${String(error)}`,
      reasonCode: "other",
    };
  }

  if (!forkPushRes.ok) {
    // Clean up the fork metadata if the snapshot push fails.
    await repository.delete(forkId).catch(() => {});
    return {
      action: "error",
      reason: `Failed to push snapshot to forked document: ${forkPushRes.status}`,
      reasonCode: "other",
    };
  }

  return { action: "forked", forkedDocumentId: forkId };
}
