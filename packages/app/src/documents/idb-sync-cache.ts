import { createStore, del, delMany, entries, get, set } from "idb-keyval";
import type { TLStoreSnapshot } from "tldraw";

const store = createStore("anipres-sync-cache", "snapshots");
const RECOVERY_KEY_MARKER = ":recovery:";
const RECOVERY_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncRecoveryState {
  baselineSnapshot: TLStoreSnapshot;
  reconnectSnapshot: TLStoreSnapshot;
  hasPendingOfflineChanges: boolean;
}

export interface SyncCacheEntry {
  snapshot: TLStoreSnapshot;
  snapshotVersion: number;
  recovery?: SyncRecoveryState;
  updatedAt?: number;
}

function getSyncCacheKey(documentId: string) {
  return `document:${documentId}`;
}

function getSyncRecoveryKey(documentId: string, sessionId: string) {
  return `document:${documentId}:recovery:${sessionId}`;
}

let tabSessionId: string | null = null;
let lastRecoveryCleanupAt = 0;
let recoveryCleanupPromise: Promise<void> | null = null;

function isRecoveryKey(key: IDBValidKey): key is string {
  return typeof key === "string" && key.includes(RECOVERY_KEY_MARKER);
}

export function isStaleRecoveryEntry(
  entry: SyncCacheEntry | undefined,
  now = Date.now(),
) {
  return !entry?.updatedAt || now - entry.updatedAt > RECOVERY_ENTRY_TTL_MS;
}

async function cleanupStaleRecoveryEntries(now = Date.now()) {
  if (recoveryCleanupPromise) {
    return recoveryCleanupPromise;
  }
  if (now - lastRecoveryCleanupAt < RECOVERY_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastRecoveryCleanupAt = now;
  recoveryCleanupPromise = (async () => {
    const staleKeys = (await entries<string, SyncCacheEntry>(store))
      .filter(
        ([key, entry]) =>
          isRecoveryKey(key) && isStaleRecoveryEntry(entry, now),
      )
      .map(([key]) => key);

    if (staleKeys.length > 0) {
      await delMany(staleKeys, store);
    }
  })().finally(() => {
    recoveryCleanupPromise = null;
  });

  await recoveryCleanupPromise;
}

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
  void cleanupStaleRecoveryEntries().catch((error) => {
    console.error("Failed to clean stale sync recovery entries", error);
  });

  const key = getSyncRecoveryKey(documentId, sessionId);
  const entry = await get<SyncCacheEntry>(key, store);
  if (isStaleRecoveryEntry(entry)) {
    await del(key, store);
    return undefined;
  }
  return entry;
}

export async function setSyncCache(
  documentId: string,
  entry: SyncCacheEntry,
): Promise<void> {
  await set(
    getSyncCacheKey(documentId),
    { ...entry, updatedAt: Date.now() } satisfies SyncCacheEntry,
    store,
  );
}

export async function setSyncRecovery(
  documentId: string,
  entry: SyncCacheEntry,
  sessionId = getSyncCacheSessionId(),
): Promise<void> {
  void cleanupStaleRecoveryEntries().catch((error) => {
    console.error("Failed to clean stale sync recovery entries", error);
  });
  await set(
    getSyncRecoveryKey(documentId, sessionId),
    { ...entry, updatedAt: Date.now() } satisfies SyncCacheEntry,
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
