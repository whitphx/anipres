import { useEffect, useMemo, useRef } from "react";
import { useSync } from "@tldraw/sync";
import { getSnapshot, type TLAssetStore, type TLStoreSnapshot } from "tldraw";
import { Anipres, allShapeUtils, allBindingUtils } from "anipres";
import { MAX_ASSET_SIZE } from "anipres-worker/tldraw-asset-policy";
import {
  deleteSyncRecovery,
  getSyncCacheSessionId,
  setSyncCache,
  setSyncRecovery,
} from "../documents/idb-sync-cache";
import {
  createRecoveryState,
  getSnapshotFingerprint,
  snapshotsEqual,
  type ReconnectSnapshotState,
} from "../documents/offline-recovery";

interface SyncedAnipresContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
  onSnapshotUpdate?: (snapshotState: {
    snapshot: TLStoreSnapshot;
    snapshotVersion: number;
    recovery: ReconnectSnapshotState;
  }) => void;
}

function createRemoteAssetStore(documentId: string): TLAssetStore {
  return {
    async upload(_asset, file) {
      // tldraw resolves copied managed asset URLs to data URLs before placing
      // them on the clipboard, then re-uploads that file on paste. That keeps
      // every synced asset owned by the destination document instead of
      // preserving a source document's asset URL across documents.
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}/assets`,
        {
          method: "POST",
          body: formData,
        },
      );
      if (!res.ok) {
        throw new Error(`Asset upload failed: ${res.status}`);
      }
      const { src } = (await res.json()) as { src: string };
      return { src };
    },
    resolve(asset) {
      return asset.props.src;
    },
  };
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

async function fetchSnapshotStatus(documentId: string): Promise<{
  snapshotVersion: number;
  snapshotFingerprint: string;
}> {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot-status`,
  );
  if (!res.ok) {
    throw new Error(`Snapshot status fetch failed: ${res.status}`);
  }
  return (await res.json()) as {
    snapshotVersion: number;
    snapshotFingerprint: string;
  };
}

export function SyncedAnipresContainer({
  documentId,
  colorScheme,
  onSnapshotUpdate,
}: SyncedAnipresContainerProps) {
  // Owns the normal online editor path: connect to the tldraw sync room,
  // upload remote assets, and publish confirmed snapshots for offline fallback.
  // Offline/reconnect mode transitions are handled by OfflineAwareSyncedContainer.
  const currentSessionId = getSyncCacheSessionId();
  const remoteAssetStore = useMemo(
    () => createRemoteAssetStore(documentId),
    [documentId],
  );
  const storeWithStatus = useSync({
    uri: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/connect/${encodeURIComponent(documentId)}`,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
    assets: remoteAssetStore,
  });

  // Cache the synced store to IDB so it's available for offline fallback.
  const snapshotVersionRef = useRef(0);
  const confirmedSnapshotRef = useRef<TLStoreSnapshot | null>(null);
  const confirmedSnapshotFingerprintRef = useRef<string | null>(null);
  const baselineSnapshotRef = useRef<TLStoreSnapshot | null>(null);
  const hasPendingOfflineChangesRef = useRef(false);
  useEffect(() => {
    snapshotVersionRef.current = 0;
    confirmedSnapshotRef.current = null;
    confirmedSnapshotFingerprintRef.current = null;
    baselineSnapshotRef.current = null;
    hasPendingOfflineChangesRef.current = false;
  }, [documentId]);

  useEffect(() => {
    if (storeWithStatus.status !== "synced-remote") return;
    const store = storeWithStatus.store;
    const currentDocumentId = documentId;
    baselineSnapshotRef.current ??= getSnapshot(store).document;
    let retryRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshSnapshotVersion = async () => {
      const { snapshotVersion, snapshotFingerprint } =
        await fetchSnapshotStatus(currentDocumentId);
      const localSnapshot = getSnapshot(store).document;
      const localSnapshotFingerprint = getSnapshotFingerprint(localSnapshot);

      // Only mark the local cache as clean once the server status confirms the
      // current local store fingerprint. That avoids re-downloading the whole
      // snapshot on every debounce while keeping the same "server caught up"
      // check as the full offline-cache payload.
      if (snapshotFingerprint === localSnapshotFingerprint) {
        snapshotVersionRef.current = snapshotVersion;
        confirmedSnapshotRef.current = localSnapshot;
        confirmedSnapshotFingerprintRef.current = localSnapshotFingerprint;
        baselineSnapshotRef.current = localSnapshot;
        hasPendingOfflineChangesRef.current = false;
        clearTimeout(retryRefreshTimer);
        return true;
      }

      if (navigator.onLine && hasPendingOfflineChangesRef.current) {
        clearTimeout(retryRefreshTimer);
        retryRefreshTimer = setTimeout(() => {
          void refreshAndPublishIfConfirmed().catch((error) => {
            console.error(
              "Failed to retry synced snapshot version refresh",
              error,
            );
          });
        }, 1000);
      }

      return false;
    };

    const publishSnapshot = () => {
      const snapshot = getSnapshot(store).document;
      const recovery = {
        baselineSnapshot:
          confirmedSnapshotRef.current ??
          baselineSnapshotRef.current ??
          snapshot,
        reconnectSnapshot: snapshot,
        hasPendingOfflineChanges: hasPendingOfflineChangesRef.current,
      };
      onSnapshotUpdate?.({
        snapshot,
        snapshotVersion: snapshotVersionRef.current,
        recovery,
      });
    };

    const persistLocalSnapshot = async () => {
      const { document } = getSnapshot(store);
      const baselineSnapshot =
        confirmedSnapshotRef.current ?? baselineSnapshotRef.current ?? document;
      await setSyncCache(currentDocumentId, {
        snapshot: baselineSnapshot,
        snapshotVersion: snapshotVersionRef.current,
      });

      if (hasPendingOfflineChangesRef.current) {
        await setSyncRecovery(
          currentDocumentId,
          {
            snapshot: document,
            snapshotVersion: snapshotVersionRef.current,
            recovery: createRecoveryState({
              baselineSnapshot,
              reconnectSnapshot: document,
              hasPendingOfflineChanges: true,
            }),
          },
          currentSessionId,
        );
        return;
      }

      await deleteSyncRecovery(currentDocumentId, currentSessionId);
    };

    const refreshAndPublishIfConfirmed = async () => {
      const confirmed = await refreshSnapshotVersion();
      if (!confirmed) return;

      publishSnapshot();
      await persistLocalSnapshot();
    };

    const flushWithVersionRefresh = async () => {
      if (navigator.onLine) {
        try {
          await refreshAndPublishIfConfirmed();
        } catch (error) {
          console.error("Failed to refresh synced snapshot version", error);
        }
      }
      publishSnapshot();
      await persistLocalSnapshot();
    };

    const flushBestEffort = async () => {
      publishSnapshot();
      await persistLocalSnapshot();

      // The page may be backgrounding or closing, so durability of the local
      // snapshot matters more than refreshing the server revision first.
      if (navigator.onLine) {
        await refreshAndPublishIfConfirmed();
      }
    };

    // Debounced write on store changes (500ms).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = store.listen(
      (entry) => {
        if (entry.source === "user") {
          hasPendingOfflineChangesRef.current = true;
        } else if (!hasPendingOfflineChangesRef.current) {
          // Before the initial offline-cache bootstrap completes, preserve the
          // latest known server-backed snapshot as the reconnect baseline.
          baselineSnapshotRef.current = getSnapshot(store).document;
        }
        publishSnapshot();
        clearTimeout(timer);
        timer = setTimeout(() => {
          void flushWithVersionRefresh().catch((error) => {
            console.error("Failed to cache synced snapshot", error);
          });
        }, 500);
      },
      { source: "all", scope: "document" },
    );

    void (async () => {
      try {
        const { snapshot, snapshotVersion } =
          await fetchOfflineCache(currentDocumentId);
        const localSnapshot = getSnapshot(store).document;

        if (!snapshotsEqual(localSnapshot, snapshot)) {
          publishSnapshot();
          await persistLocalSnapshot();
          return;
        }

        snapshotVersionRef.current = snapshotVersion;
        confirmedSnapshotRef.current = snapshot;
        confirmedSnapshotFingerprintRef.current =
          getSnapshotFingerprint(snapshot);
        baselineSnapshotRef.current = snapshot;
        hasPendingOfflineChangesRef.current = false;
        onSnapshotUpdate?.({
          snapshot,
          snapshotVersion,
          recovery: {
            baselineSnapshot: snapshot,
            reconnectSnapshot: snapshot,
            hasPendingOfflineChanges: false,
          },
        });
        await setSyncCache(currentDocumentId, {
          snapshot,
          snapshotVersion,
        });
        await deleteSyncRecovery(currentDocumentId, currentSessionId);
      } catch (error) {
        console.error("Failed to initialize synced snapshot cache", error);
      }
    })();

    // Seed the wrapper with the live synced state immediately so a first
    // disconnect does not depend on the async cache bootstrap finishing first.
    publishSnapshot();

    // Flush on visibility hidden and page hide (best-effort for tab close).
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flushBestEffort().catch((error) => {
          console.error("Failed to cache synced snapshot on hide", error);
        });
      }
    };
    const handlePageHide = () => {
      void flushBestEffort().catch((error) => {
        console.error("Failed to cache synced snapshot on pagehide", error);
      });
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      clearTimeout(timer);
      clearTimeout(retryRefreshTimer);
      stopListening();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [currentSessionId, documentId, onSnapshotUpdate, storeWithStatus]);

  return (
    <Anipres
      key={documentId}
      store={storeWithStatus}
      colorScheme={colorScheme}
      maxAssetSize={MAX_ASSET_SIZE}
    />
  );
}
