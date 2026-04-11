import { useEffect, useMemo, useRef } from "react";
import { useSync } from "@tldraw/sync";
import { getSnapshot, type TLAssetStore } from "tldraw";
import { Anipres, allShapeUtils, allBindingUtils } from "anipres";
import { setSyncCache } from "../documents/idb-sync-cache";

interface SyncedAnipresContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
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

async function fetchSnapshotVersion(documentId: string) {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot-version`,
  );
  if (!res.ok) {
    throw new Error(`Snapshot version fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { snapshotVersion: number };
  return body.snapshotVersion;
}

export function SyncedAnipresContainer({
  documentId,
  colorScheme,
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
  const documentIdRef = useRef(documentId);
  useEffect(() => {
    documentIdRef.current = documentId;
  }, [documentId]);
  useEffect(() => {
    if (storeWithStatus.status !== "synced-remote") return;

    const store = storeWithStatus.store;

    const flush = async () => {
      const { document } = getSnapshot(store);
      const snapshotVersion = await fetchSnapshotVersion(documentIdRef.current);
      await setSyncCache(documentIdRef.current, document, snapshotVersion);
    };

    // Debounced write on store changes (500ms).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = store.listen(
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void flush().catch((error) => {
            console.error("Failed to cache synced snapshot", error);
          });
        }, 500);
      },
      { source: "all", scope: "document" },
    );

    void flush().catch((error) => {
      console.error("Failed to initialize synced snapshot cache", error);
    });

    // Flush on visibility hidden and page hide (best-effort for tab close).
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flush().catch((error) => {
          console.error("Failed to cache synced snapshot on hide", error);
        });
      }
    };
    const handlePageHide = () => {
      void flush().catch((error) => {
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
  }, [storeWithStatus]);

  return (
    <Anipres
      key={documentId}
      store={storeWithStatus}
      colorScheme={colorScheme}
    />
  );
}
