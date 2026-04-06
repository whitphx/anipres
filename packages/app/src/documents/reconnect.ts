import type { TLStoreSnapshot } from "tldraw";
import type { ApiDocumentRepository } from "./api-repository";

export type ReconnectResult =
  | { action: "pushed" }
  | { action: "forked"; forkedDocumentId: string }
  | { action: "error"; reason: string };

/**
 * After an offline editing session, decide whether to push the local snapshot
 * to the server (if the server state hasn't changed) or fork the document
 * (if someone else edited it while we were offline).
 */
export async function reconcileOfflineEdits(params: {
  documentId: string;
  localSnapshot: TLStoreSnapshot;
  cachedAt: number;
  repository: ApiDocumentRepository;
}): Promise<ReconnectResult> {
  const { documentId, localSnapshot, cachedAt, repository } = params;

  // Fetch current server metadata to compare timestamps.
  const serverDoc = await repository.get(documentId);
  if (!serverDoc) {
    return { action: "error", reason: "Document no longer exists on server" };
  }

  // Try to push: the server endpoint rejects with 409 if updated_at diverged.
  const pushRes = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot: localSnapshot,
        expectedUpdatedAt: cachedAt,
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
    };
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
        expectedUpdatedAt: now,
      }),
    },
  );

  if (!forkPushRes.ok) {
    // Clean up the fork metadata if the snapshot push fails.
    await repository.delete(forkId).catch(() => {});
    return {
      action: "error",
      reason: `Failed to push snapshot to forked document: ${forkPushRes.status}`,
    };
  }

  return { action: "forked", forkedDocumentId: forkId };
}
