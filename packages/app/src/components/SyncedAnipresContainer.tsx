import { useEffect, useMemo, useRef } from "react";
import { useSync } from "@tldraw/sync";
import { getSnapshot, type TLAssetStore, type TLStoreSnapshot } from "tldraw";
import { Anipres, allShapeUtils, allBindingUtils } from "anipres";
import { setSyncCache } from "../documents/idb-sync-cache";

interface SyncedAnipresContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
  onSnapshotUpdate?: (snapshotState: {
    snapshot: TLStoreSnapshot;
    snapshotVersion: number;
    baselineSnapshot: TLStoreSnapshot;
    reconnectSnapshot: TLStoreSnapshot;
    hasPendingOfflineChanges: boolean;
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

export function SyncedAnipresContainer({
  documentId,
  colorScheme,
  onSnapshotUpdate,
}: SyncedAnipresContainerProps) {
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
  useEffect(() => {
    if (storeWithStatus.status !== "synced-remote") return;
    const store = storeWithStatus.store;
    const currentDocumentId = documentId;
    snapshotVersionRef.current = 0;
    let confirmedSnapshotRef: TLStoreSnapshot | null = null;
    let hasObservedLocalChanges = false;
    let hasPendingOfflineChanges = false;

    const refreshSnapshotVersion = async () => {
      const { snapshot, snapshotVersion } =
        await fetchOfflineCache(currentDocumentId);
      const localSnapshot = getSnapshot(store).document;

      // Only mark the local cache as clean once the server snapshot matches
      // the current local store. A slower offline-cache fetch can otherwise
      // race behind a just-made local edit and incorrectly clear the pending
      // flag before that edit is actually reflected by the server state.
      if (snapshotsEqual(snapshot, localSnapshot)) {
        snapshotVersionRef.current = snapshotVersion;
        confirmedSnapshotRef = snapshot;
        hasPendingOfflineChanges = false;
      }
    };

    const publishSnapshot = () => {
      const snapshot = getSnapshot(store).document;
      onSnapshotUpdate?.({
        snapshot,
        snapshotVersion: snapshotVersionRef.current,
        baselineSnapshot: confirmedSnapshotRef ?? snapshot,
        reconnectSnapshot: snapshot,
        hasPendingOfflineChanges,
      });
    };

    const persistLocalSnapshot = async () => {
      const { document } = getSnapshot(store);
      await setSyncCache(
        currentDocumentId,
        document,
        snapshotVersionRef.current,
        hasPendingOfflineChanges,
        confirmedSnapshotRef ?? document,
        document,
      );
    };

    const flushWithVersionRefresh = async () => {
      if (navigator.onLine) {
        try {
          await refreshSnapshotVersion();
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
        await refreshSnapshotVersion();
        publishSnapshot();
        await persistLocalSnapshot();
      }
    };

    // Debounced write on store changes (500ms).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = store.listen(
      () => {
        hasObservedLocalChanges = true;
        hasPendingOfflineChanges = true;
        publishSnapshot();
        clearTimeout(timer);
        timer = setTimeout(() => {
          void flushWithVersionRefresh().catch((error) => {
            console.error("Failed to cache synced snapshot", error);
          });
        }, 500);
      },
      { source: "user", scope: "document" },
    );

    void (async () => {
      try {
        const { snapshot, snapshotVersion } =
          await fetchOfflineCache(currentDocumentId);
        snapshotVersionRef.current = snapshotVersion;
        confirmedSnapshotRef = snapshot;
        if (hasObservedLocalChanges) {
          publishSnapshot();
          await persistLocalSnapshot();
          return;
        }
        onSnapshotUpdate?.({
          snapshot,
          snapshotVersion,
          baselineSnapshot: snapshot,
          reconnectSnapshot: snapshot,
          hasPendingOfflineChanges: false,
        });
        await setSyncCache(
          currentDocumentId,
          snapshot,
          snapshotVersion,
          false,
          snapshot,
          snapshot,
        );
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
      stopListening();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [documentId, onSnapshotUpdate, storeWithStatus]);

  return (
    <Anipres
      key={documentId}
      store={storeWithStatus}
      colorScheme={colorScheme}
    />
  );
}
