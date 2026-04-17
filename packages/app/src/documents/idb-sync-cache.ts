import { createStore, get, set, del } from "idb-keyval";
import type { TLStoreSnapshot } from "tldraw";

const store = createStore("anipres-sync-cache", "snapshots");

interface SyncCacheEntry {
  snapshot: TLStoreSnapshot;
  snapshotVersion: number;
  hasPendingOfflineChanges?: boolean;
  baselineSnapshot?: TLStoreSnapshot;
  reconnectSnapshot?: TLStoreSnapshot;
  ownerSessionId?: string;
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
  return get<SyncCacheEntry>(documentId, store);
}

export async function setSyncCache(
  documentId: string,
  snapshot: TLStoreSnapshot,
  snapshotVersion: number,
  hasPendingOfflineChanges = false,
  baselineSnapshot?: TLStoreSnapshot,
  reconnectSnapshot?: TLStoreSnapshot,
  ownerSessionId = getSyncCacheSessionId(),
): Promise<void> {
  await set(
    documentId,
    {
      snapshot,
      snapshotVersion,
      hasPendingOfflineChanges,
      baselineSnapshot,
      reconnectSnapshot,
      ownerSessionId,
    } satisfies SyncCacheEntry,
    store,
  );
}

export async function deleteSyncCache(documentId: string): Promise<void> {
  await del(documentId, store);
}
