import { createStore, get, set, del } from "idb-keyval";
import type { TLStoreSnapshot } from "tldraw";

const store = createStore("anipres-sync-cache", "snapshots");

export interface SyncRecoveryState {
  baselineSnapshot: TLStoreSnapshot;
  reconnectSnapshot: TLStoreSnapshot;
  hasPendingOfflineChanges: boolean;
}

export interface SyncCacheEntry {
  snapshot: TLStoreSnapshot;
  snapshotVersion: number;
  recovery?: SyncRecoveryState;
}

function getSyncCacheKey(documentId: string) {
  return `document:${documentId}`;
}

function getSyncRecoveryKey(documentId: string, sessionId: string) {
  return `document:${documentId}:recovery:${sessionId}`;
}

let tabSessionId: string | null = null;

export function getSyncCacheSessionId(): string {
  if (tabSessionId) {
    return tabSessionId;
  }

  try {
    const existing = window.sessionStorage.getItem(
      "anipres-sync-cache-session",
    );
    if (existing) {
      tabSessionId = existing;
      return existing;
    }

    const created = crypto.randomUUID();
    window.sessionStorage.setItem("anipres-sync-cache-session", created);
    tabSessionId = created;
    return created;
  } catch {
    tabSessionId = crypto.randomUUID();
    return tabSessionId;
  }
}

export async function getSyncCache(
  documentId: string,
): Promise<SyncCacheEntry | undefined> {
  return get<SyncCacheEntry>(getSyncCacheKey(documentId), store);
}

export async function getSyncRecovery(
  documentId: string,
  sessionId = getSyncCacheSessionId(),
): Promise<SyncCacheEntry | undefined> {
  return get<SyncCacheEntry>(getSyncRecoveryKey(documentId, sessionId), store);
}

export async function setSyncCache(
  documentId: string,
  entry: SyncCacheEntry,
): Promise<void> {
  await set(getSyncCacheKey(documentId), entry satisfies SyncCacheEntry, store);
}

export async function setSyncRecovery(
  documentId: string,
  entry: SyncCacheEntry,
  sessionId = getSyncCacheSessionId(),
): Promise<void> {
  await set(
    getSyncRecoveryKey(documentId, sessionId),
    entry satisfies SyncCacheEntry,
    store,
  );
}

export async function deleteSyncCache(documentId: string): Promise<void> {
  await del(getSyncCacheKey(documentId), store);
}

export async function deleteSyncRecovery(
  documentId: string,
  sessionId = getSyncCacheSessionId(),
): Promise<void> {
  await del(getSyncRecoveryKey(documentId, sessionId), store);
}
