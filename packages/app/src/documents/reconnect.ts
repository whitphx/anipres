import type { TLStoreSnapshot } from "tldraw";
import { v7 as uuidv7 } from "uuid";
import { apiClient } from "../lib/api-client";
import type { ApiDocumentRepository } from "./api-repository";
import {
  snapshotsEqual,
  shouldSkipReconnect,
  type ReconnectSnapshotState,
} from "./offline-recovery";
import { nextTailSortOrder } from "./sort-order";
import { CLIENT_TOO_OLD_MESSAGE } from "../lib/client-version";
import { putSnapshot } from "./snapshot-push";

export type ReconnectResult =
  | { action: "noop" }
  | { action: "pushed" }
  | { action: "forked"; forkedDocumentId: string }
  | {
      action: "error";
      reason: string;
      /**
       * `client-too-old` = the worker's animation-data version gate
       * rejected the push (HTTP 426): retrying from this bundle can
       * never succeed — the caller must offer a reload instead.
       */
      reasonCode?: "active-session" | "client-too-old" | "other";
    };

const CLIENT_TOO_OLD_RESULT: ReconnectResult = {
  action: "error",
  reason: CLIENT_TOO_OLD_MESSAGE,
  reasonCode: "client-too-old",
};

async function fetchOfflineCache(documentId: string): Promise<{
  snapshot: TLStoreSnapshot;
  snapshotVersion: number;
}> {
  const res = await apiClient.api.documents[":id"]["offline-cache"].$get({
    param: { id: documentId },
  });
  if (!res.ok) {
    throw new Error(`Offline cache fetch failed: ${res.status}`);
  }
  return (await res.json()) as unknown as {
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

  // Try to push: the server endpoint rejects with 409 if the DO
  // snapshot version has advanced since this cached snapshot was
  // written.
  const push = await putSnapshot({
    documentId,
    snapshot: localSnapshot,
    expectedSnapshotVersion: snapshotVersion,
  });

  if (push.outcome === "success") {
    return { action: "pushed" };
  }

  if (push.outcome === "client-too-old") {
    return CLIENT_TOO_OLD_RESULT;
  }

  if (push.outcome === "failed") {
    return {
      action: "error",
      reason: `Snapshot push failed: ${push.status}`,
      reasonCode: "other",
    };
  }

  if (push.reason === "active-session") {
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
      const retryPush = await putSnapshot({
        documentId,
        snapshot: localSnapshot,
        expectedSnapshotVersion: serverCache.snapshotVersion,
      });

      if (retryPush.outcome === "success") {
        return { action: "pushed" };
      }

      if (retryPush.outcome === "client-too-old") {
        return CLIENT_TOO_OLD_RESULT;
      }

      if (retryPush.outcome === "conflict") {
        if (retryPush.reason === "active-session") {
          return {
            action: "error",
            reason: "Document is still open in another session",
            reasonCode: "active-session",
          };
        }
        // version-conflict again: fall through to the fork decision.
      } else {
        return {
          action: "error",
          reason: `Snapshot retry failed: ${retryPush.status}`,
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

  // The fork's id is minted client-side as UUID v7 — same scheme as
  // every other doc id. Place the fork past the synced list's
  // current tail so the new key is strictly greater than every
  // existing key — generating off the original's key alone would
  // collide with whatever doc sits immediately after it.
  const forkId = uuidv7();
  const syncedList = await repository.list();
  const forkSortOrder = nextTailSortOrder(syncedList);
  await repository.save({
    meta: {
      id: forkId,
      title: forkTitle,
      sortOrder: forkSortOrder,
      source: "synced",
    },
    snapshot: null,
  });

  // The fork row was created but never seeded: cancel it through the
  // dedicated initialization-cancel endpoint (the regular DELETE route
  // deliberately 404s initializing rows, which the user never saw).
  // Cancellation failures are swallowed — the row stays invisible and
  // the server's initialization sweep reaps it — and never displace
  // the push's own error result.
  const cancelFork = () =>
    repository.cancelInitialization(forkId).catch(() => {});

  let forkPush;
  try {
    forkPush = await putSnapshot({
      documentId: forkId,
      snapshot: localSnapshot,
      expectedSnapshotVersion: 0,
    });
  } catch (error) {
    await cancelFork();
    return {
      action: "error",
      reason: `Failed to push snapshot to forked document: ${String(error)}`,
      reasonCode: "other",
    };
  }

  if (forkPush.outcome !== "success") {
    await cancelFork();
    if (forkPush.outcome === "client-too-old") {
      return CLIENT_TOO_OLD_RESULT;
    }
    return {
      action: "error",
      reason: `Failed to push snapshot to forked document: ${forkPush.status}`,
      reasonCode: "other",
    };
  }

  return { action: "forked", forkedDocumentId: forkId };
}
