import type { TLStoreSnapshot } from "tldraw";
import type { SyncCacheEntry, SyncRecoveryState } from "./idb-sync-cache";

export interface ReconnectSnapshotState {
  baselineSnapshot: TLStoreSnapshot;
  reconnectSnapshot: TLStoreSnapshot;
  hasPendingOfflineChanges: boolean;
}

export interface OfflineSnapshotState extends ReconnectSnapshotState {
  snapshot: TLStoreSnapshot;
}

export type StartupState =
  | { type: "synced" }
  | { type: "unavailable" }
  | {
      type: "reconnecting";
      snapshot: TLStoreSnapshot;
      recovery: ReconnectSnapshotState;
    }
  | {
      type: "offline";
      snapshot: TLStoreSnapshot;
      recovery: ReconnectSnapshotState;
      shouldAutoReconnect: boolean;
    };

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJsonValue(child)]),
    );
  }

  return value;
}

export function getCanonicalSnapshotJson(snapshot: TLStoreSnapshot) {
  return JSON.stringify(canonicalizeJsonValue(snapshot));
}

function hashString64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function getSnapshotFingerprint(snapshot: TLStoreSnapshot) {
  return hashString64(getCanonicalSnapshotJson(snapshot));
}

export function snapshotsEqual(a: TLStoreSnapshot, b: TLStoreSnapshot) {
  return getSnapshotFingerprint(a) === getSnapshotFingerprint(b);
}

export function getOfflineSnapshotState(
  entry: SyncCacheEntry,
): OfflineSnapshotState {
  return {
    snapshot: entry.snapshot,
    baselineSnapshot: entry.recovery?.baselineSnapshot ?? entry.snapshot,
    reconnectSnapshot: entry.recovery?.reconnectSnapshot ?? entry.snapshot,
    hasPendingOfflineChanges: entry.recovery?.hasPendingOfflineChanges ?? false,
  };
}

export function resolveStartupState(params: {
  cacheEntry: SyncCacheEntry | undefined;
  recoveryEntry: SyncCacheEntry | undefined;
  isOnline: boolean;
}): StartupState {
  const { cacheEntry, recoveryEntry, isOnline } = params;

  if (isOnline) {
    if (recoveryEntry) {
      const { snapshot, ...recovery } = getOfflineSnapshotState(recoveryEntry);
      return {
        type: "reconnecting",
        snapshot,
        recovery,
      };
    }

    return { type: "synced" };
  }

  if (recoveryEntry) {
    const { snapshot, ...recovery } = getOfflineSnapshotState(recoveryEntry);
    return {
      type: "offline",
      snapshot,
      recovery,
      shouldAutoReconnect: false,
    };
  }

  if (!cacheEntry) {
    return { type: "unavailable" };
  }

  const { snapshot, ...recovery } = getOfflineSnapshotState(cacheEntry);
  return {
    type: "offline",
    snapshot,
    recovery,
    shouldAutoReconnect: false,
  };
}

export function shouldSkipReconnect(params: {
  snapshot: TLStoreSnapshot;
  recovery: ReconnectSnapshotState;
}) {
  const { snapshot, recovery } = params;
  return (
    snapshotsEqual(snapshot, recovery.baselineSnapshot) ||
    (!recovery.hasPendingOfflineChanges &&
      snapshotsEqual(snapshot, recovery.reconnectSnapshot))
  );
}

export function createRecoveryState(params: {
  baselineSnapshot: TLStoreSnapshot;
  reconnectSnapshot: TLStoreSnapshot;
  hasPendingOfflineChanges: boolean;
}): SyncRecoveryState {
  return {
    baselineSnapshot: params.baselineSnapshot,
    reconnectSnapshot: params.reconnectSnapshot,
    hasPendingOfflineChanges: params.hasPendingOfflineChanges,
  };
}
