import { createStore, get, set, del } from "idb-keyval";
import type { TLStoreSnapshot } from "tldraw";

const store = createStore("anipres-sync-cache", "snapshots");

interface SyncCacheEntry {
  snapshot: TLStoreSnapshot;
  cachedAt: number;
}

export async function getSyncCache(
  documentId: string,
): Promise<SyncCacheEntry | undefined> {
  return get<SyncCacheEntry>(documentId, store);
}

export async function setSyncCache(
  documentId: string,
  snapshot: TLStoreSnapshot,
): Promise<void> {
  await set(
    documentId,
    { snapshot, cachedAt: Date.now() } satisfies SyncCacheEntry,
    store,
  );
}

export async function deleteSyncCache(documentId: string): Promise<void> {
  await del(documentId, store);
}
