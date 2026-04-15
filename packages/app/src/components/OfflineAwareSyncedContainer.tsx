import { useCallback, useEffect, useRef, useState } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import { Anipres } from "anipres";
import { SyncedAnipresContainer } from "./SyncedAnipresContainer";
import {
  getSyncCache,
  deleteSyncCache,
  setSyncCache,
} from "../documents/idb-sync-cache";
import { reconcileOfflineEdits } from "../documents/reconnect";
import { ApiDocumentRepository } from "../documents/api-repository";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";

type Mode =
  | { type: "loading" }
  | { type: "synced" }
  | {
      type: "offline";
      snapshot: TLStoreSnapshot;
      baselineSnapshot: TLStoreSnapshot;
      reconnectSnapshot: TLStoreSnapshot;
    }
  | { type: "reconnecting" }
  | { type: "unavailable" };

interface OfflineAwareSyncedContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
}

const repository = new ApiDocumentRepository();

function snapshotsEqual(a: TLStoreSnapshot, b: TLStoreSnapshot) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function OfflineAwareSyncedContainer({
  documentId,
  colorScheme,
}: OfflineAwareSyncedContainerProps) {
  const [mode, setMode] = useState<Mode>({ type: "loading" });
  const { refreshDocuments, selectDocument } = useDocumentManagerContext();

  // Track the offline editor so we can grab its snapshot for reconciliation.
  const offlineEditorRef = useRef<Editor | null>(null);
  const [offlineEditor, setOfflineEditor] = useState<Editor | null>(null);
  const snapshotVersionRef = useRef<number>(0);
  const shouldAutoReconnectRef = useRef(false);
  const liveSyncedSnapshotStateRef = useRef<{
    snapshot: TLStoreSnapshot;
    snapshotVersion: number;
    baselineSnapshot: TLStoreSnapshot;
    reconnectSnapshot: TLStoreSnapshot;
    hasPendingOfflineChanges: boolean;
  } | null>(null);
  const retryHandleOnlineRef = useRef<(() => void) | null>(null);
  const reconnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // On mount, load any cached snapshot. If it contains pending offline edits,
  // restore it even when the browser is back online so we can reconcile it
  // before the synced container overwrites the cache with server state.
  useEffect(() => {
    let cancelled = false;
    getSyncCache(documentId).then((entry) => {
      if (cancelled) return;
      if (entry) {
        snapshotVersionRef.current = entry.snapshotVersion;
        const baselineSnapshot = entry.baselineSnapshot ?? entry.snapshot;
        const reconnectSnapshot = entry.reconnectSnapshot ?? entry.snapshot;
        if (navigator.onLine && entry.hasPendingOfflineChanges) {
          shouldAutoReconnectRef.current = true;
          setMode({
            type: "offline",
            snapshot: entry.snapshot,
            baselineSnapshot,
            reconnectSnapshot,
          });
        } else if (!navigator.onLine) {
          setMode({
            type: "offline",
            snapshot: entry.snapshot,
            baselineSnapshot,
            reconnectSnapshot,
          });
        } else {
          setMode({ type: "synced" });
        }
      } else {
        setMode(
          navigator.onLine ? { type: "synced" } : { type: "unavailable" },
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Listen for online event to trigger reconnection.
  const handleOnline = useCallback(async () => {
    if (reconnectRetryTimerRef.current) {
      clearTimeout(reconnectRetryTimerRef.current);
      reconnectRetryTimerRef.current = null;
    }

    // If we couldn't load any cached snapshot, just switch to synced mode now
    // that the network is back — useSync can fetch the live state.
    if (mode.type === "unavailable") {
      setMode({ type: "synced" });
      return;
    }
    if (mode.type !== "offline") return;

    setMode({ type: "reconnecting" });

    // Grab the latest snapshot from the offline editor if available.
    const editor = offlineEditorRef.current;
    let snapshot: TLStoreSnapshot | undefined;
    if (editor) {
      snapshot = getSnapshot(editor.store).document;
    }

    if (!snapshot) {
      // No edits were made offline, just switch to synced mode.
      await deleteSyncCache(documentId);
      setMode({ type: "synced" });
      return;
    }

    if (snapshotsEqual(snapshot, mode.baselineSnapshot)) {
      await deleteSyncCache(documentId);
      setMode({ type: "synced" });
      return;
    }

    try {
      const result = await reconcileOfflineEdits({
        documentId,
        localSnapshot: snapshot,
        baselineSnapshot: mode.baselineSnapshot,
        reconnectSnapshot: mode.reconnectSnapshot,
        snapshotVersion: snapshotVersionRef.current,
        repository,
      });

      if (result.action === "pushed") {
        // Only clear the cache after a successful push so transient errors do
        // not cause permanent data loss.
        await deleteSyncCache(documentId);
        setMode({ type: "synced" });
      } else if (result.action === "forked") {
        await deleteSyncCache(documentId);
        await refreshDocuments();
        await selectDocument(result.forkedDocumentId);
        // selectDocument will cause a re-render with the new documentId, which
        // will mount a fresh SyncedAnipresContainer for the forked document.
      } else {
        // Error during reconciliation — preserve the offline cache so the user
        // can retry. Stay in offline mode so they can keep editing locally.
        console.error("Offline reconciliation failed:", result.reason);
        if (result.reasonCode === "active-session") {
          if (reconnectRetryTimerRef.current) {
            clearTimeout(reconnectRetryTimerRef.current);
          }
          reconnectRetryTimerRef.current = setTimeout(() => {
            retryHandleOnlineRef.current?.();
          }, 3000);
        }
        setMode({
          type: "offline",
          snapshot,
          baselineSnapshot: mode.baselineSnapshot,
          reconnectSnapshot: mode.reconnectSnapshot,
        });
      }
    } catch (error) {
      console.error("Offline reconciliation threw unexpectedly:", error);
      setMode({
        type: "offline",
        snapshot,
        baselineSnapshot: mode.baselineSnapshot,
        reconnectSnapshot: mode.reconnectSnapshot,
      });
    }
  }, [mode, documentId, refreshDocuments, selectDocument]);

  useEffect(() => {
    retryHandleOnlineRef.current = () => {
      void handleOnline();
    };
    return () => {
      retryHandleOnlineRef.current = null;
    };
  }, [handleOnline]);

  useEffect(() => {
    return () => {
      if (reconnectRetryTimerRef.current) {
        clearTimeout(reconnectRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [handleOnline]);

  useEffect(() => {
    const currentDocumentId = documentId;

    const handleOffline = () => {
      if (mode.type !== "synced") {
        return;
      }

      const liveSnapshotState = liveSyncedSnapshotStateRef.current;
      if (liveSnapshotState) {
        setMode({
          type: "offline",
          snapshot: liveSnapshotState.snapshot,
          baselineSnapshot: liveSnapshotState.baselineSnapshot,
          reconnectSnapshot: liveSnapshotState.reconnectSnapshot,
        });
        snapshotVersionRef.current = liveSnapshotState.snapshotVersion;
        void setSyncCache(
          currentDocumentId,
          liveSnapshotState.snapshot,
          liveSnapshotState.snapshotVersion,
          liveSnapshotState.hasPendingOfflineChanges,
          liveSnapshotState.baselineSnapshot,
          liveSnapshotState.reconnectSnapshot,
        ).catch((error) => {
          console.error(
            "Failed to persist live snapshot after disconnect",
            error,
          );
        });
        return;
      }

      void getSyncCache(currentDocumentId)
        .then((entry) => {
          if (entry) {
            snapshotVersionRef.current = entry.snapshotVersion;
            setMode({
              type: "offline",
              snapshot: entry.snapshot,
              baselineSnapshot: entry.baselineSnapshot ?? entry.snapshot,
              reconnectSnapshot: entry.reconnectSnapshot ?? entry.snapshot,
            });
            return;
          }

          setMode({ type: "unavailable" });
        })
        .catch((error) => {
          console.error(
            "Failed to load offline snapshot after disconnect",
            error,
          );
          setMode({ type: "unavailable" });
        });
    };

    window.addEventListener("offline", handleOffline);
    return () => window.removeEventListener("offline", handleOffline);
  }, [documentId, mode.type]);

  useEffect(() => {
    if (
      !shouldAutoReconnectRef.current ||
      !navigator.onLine ||
      mode.type !== "offline" ||
      !offlineEditor
    ) {
      return;
    }

    shouldAutoReconnectRef.current = false;
    const timer = setTimeout(() => {
      void handleOnline();
    }, 0);

    return () => clearTimeout(timer);
  }, [handleOnline, mode.type, offlineEditor]);

  const handleOfflineMount = useCallback((editor: Editor) => {
    offlineEditorRef.current = editor;
    setOfflineEditor(editor);
  }, []);

  useEffect(() => {
    if (mode.type !== "offline") {
      return;
    }

    if (!offlineEditor) {
      return;
    }

    const flush = async () => {
      const snapshot = getSnapshot(offlineEditor.store).document;
      await setSyncCache(
        documentId,
        snapshot,
        snapshotVersionRef.current,
        true,
        mode.baselineSnapshot,
        mode.reconnectSnapshot,
      );
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = offlineEditor.store.listen(
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void flush().catch((error) => {
            console.error("Failed to cache offline snapshot", error);
          });
        }, 500);
      },
      { source: "all", scope: "document" },
    );

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void flush().catch((error) => {
          console.error("Failed to cache offline snapshot on hide", error);
        });
      }
    };
    const handlePageHide = () => {
      void flush().catch((error) => {
        console.error("Failed to cache offline snapshot on pagehide", error);
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
  }, [
    documentId,
    mode.type === "offline" ? mode.baselineSnapshot : undefined,
    mode.type === "offline" ? mode.reconnectSnapshot : undefined,
    mode.type,
    offlineEditor,
  ]);

  if (mode.type === "synced") {
    return (
      <SyncedAnipresContainer
        documentId={documentId}
        colorScheme={colorScheme}
        onSnapshotUpdate={(snapshotState) => {
          liveSyncedSnapshotStateRef.current = snapshotState;
          snapshotVersionRef.current = snapshotState.snapshotVersion;
        }}
      />
    );
  }

  if (mode.type === "offline") {
    return (
      <>
        <div
          role="status"
          style={{
            position: "fixed",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: "#f59e0b",
            color: "#000",
            padding: "4px 16px",
            borderRadius: "0 0 6px 6px",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Offline — changes saved locally
        </div>
        <Anipres
          key={`offline-${documentId}`}
          snapshot={mode.snapshot}
          onMount={handleOfflineMount}
          colorScheme={colorScheme}
        />
      </>
    );
  }

  if (mode.type === "reconnecting") {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          fontSize: 14,
          color: "#666",
        }}
      >
        Reconnecting...
      </div>
    );
  }

  if (mode.type === "loading") {
    return (
      <div
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          fontSize: 14,
          color: "#666",
        }}
      >
        Loading...
      </div>
    );
  }

  // unavailable
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        fontSize: 14,
        color: "#666",
      }}
    >
      This document is not available offline.
    </div>
  );
}
