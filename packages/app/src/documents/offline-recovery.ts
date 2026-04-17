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
  entry: SyncCacheEntry | undefined;
  isOnline: boolean;
  currentSessionId: string;
}): StartupState {
  const { entry, isOnline, currentSessionId } = params;

  if (!entry) {
    return isOnline ? { type: "synced" } : { type: "unavailable" };
  }

  if (isOnline) {
    if (entry.recovery?.ownerSessionId === currentSessionId) {
      const { snapshot, ...recovery } = getOfflineSnapshotState(entry);
      return {
        type: "offline",
        snapshot,
        recovery,
        shouldAutoReconnect: true,
      };
    }

    return { type: "synced" };
  }

  const { snapshot, ...recovery } = getOfflineSnapshotState(entry);
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
  ownerSessionId: string;
}): SyncRecoveryState {
  return {
    baselineSnapshot: params.baselineSnapshot,
    reconnectSnapshot: params.reconnectSnapshot,
    hasPendingOfflineChanges: params.hasPendingOfflineChanges,
    ownerSessionId: params.ownerSessionId,
  };
}
