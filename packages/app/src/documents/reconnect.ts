import type { TLStoreSnapshot } from "tldraw";
import type { ApiDocumentRepository } from "./api-repository";

export type ReconnectResult =
  | { action: "pushed" }
  | { action: "forked"; forkedDocumentId: string }
  | {
      action: "error";
      reason: string;
      reasonCode?: "active-session" | "other";
    };

/**
 * After an offline editing session, decide whether to push the local snapshot
 * to the server (if the server state hasn't changed) or fork the document
 * (if someone else edited it while we were offline).
 */
function snapshotsEqual(a: TLStoreSnapshot, b: TLStoreSnapshot) {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
  snapshotVersion: number;
  repository: ApiDocumentRepository;
}): Promise<ReconnectResult> {
  const { documentId, localSnapshot, snapshotVersion, repository } = params;

  // Fetch current server metadata before deciding whether to fork on conflict.
  const serverDoc = await repository.get(documentId);
  if (!serverDoc) {
    return {
      action: "error",
      reason: "Document no longer exists on server",
      reasonCode: "other",
    };
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
  } catch (error) {
    console.error("Failed to compare server snapshot after conflict:", error);
  }

  // Server has diverged — fork the local version as a new document.
  const originalTitle = serverDoc.meta.title;
  const forkTitle = `${originalTitle} (offline copy)`;
  const forkId = crypto.randomUUID();
  const now = Date.now();

  // Create the fork document metadata on the server.
  await repository.save({
    meta: {
      id: forkId,
      title: forkTitle,
      createdAt: now,
      updatedAt: now,
      order: serverDoc.meta.order + 0.001,
    },
    snapshot: null,
  });

  // Push the local snapshot into the fork's Durable Object room.
  const forkPushRes = await fetch(
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
