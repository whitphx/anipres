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
      type: "offline";
      snapshot: TLStoreSnapshot;
      recovery: ReconnectSnapshotState;
      shouldAutoReconnect: boolean;
    };

export function snapshotsEqual(a: TLStoreSnapshot, b: TLStoreSnapshot) {
  return JSON.stringify(a) === JSON.stringify(b);
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
        type: "offline",
        snapshot,
        recovery,
        shouldAutoReconnect: true,
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
