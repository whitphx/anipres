import { useCallback, useEffect, useRef, useState } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import { Anipres } from "anipres";
import { MAX_ASSET_SIZE } from "anipres-worker/tldraw-asset-policy";
import { SyncedAnipresContainer } from "./SyncedAnipresContainer";
import {
  createRecoveryState,
  resolveStartupState,
  type ReconnectSnapshotState,
} from "../documents/offline-recovery";
import {
  deleteSyncRecovery,
  getSyncCache,
  getSyncRecovery,
  setSyncCache,
  setSyncRecovery,
  getSyncCacheSessionId,
} from "../documents/idb-sync-cache";
import {
  reconcileOfflineEdits,
  type ReconnectResult,
} from "../documents/reconnect";
import { useSyncedRepository } from "../documents/useSyncedRepository";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";

type Mode =
  | { type: "loading" }
  | { type: "synced" }
  | {
      type: "offline";
      snapshot: TLStoreSnapshot;
      recovery: ReconnectSnapshotState;
    }
  | {
      type: "reconnecting";
      snapshot: TLStoreSnapshot;
      recovery: ReconnectSnapshotState;
    }
  | { type: "unavailable" };

interface OfflineAwareSyncedContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
}

// Owns the sync editor lifecycle: startup cache restore, offline fallback,
// reconnect reconciliation, and switching to a forked document on conflict.
// The live WebSocket-backed editor itself stays inside SyncedAnipresContainer.
export function OfflineAwareSyncedContainer({
  documentId,
  colorScheme,
}: OfflineAwareSyncedContainerProps) {
  const [mode, setMode] = useState<Mode>({ type: "loading" });
  const { refreshDocuments, selectDocument } = useDocumentManagerContext();
  const repository = useSyncedRepository();
  const currentSessionId = getSyncCacheSessionId();

  // Track the offline editor so we can grab its snapshot for reconciliation.
  const offlineEditorRef = useRef<Editor | null>(null);
  const [offlineEditor, setOfflineEditor] = useState<Editor | null>(null);
  const snapshotVersionRef = useRef<number>(0);
  const shouldAutoReconnectRef = useRef(false);
  const liveSyncedSnapshotStateRef = useRef<{
    snapshot: TLStoreSnapshot;
    snapshotVersion: number;
    recovery: ReconnectSnapshotState;
  } | null>(null);
  const retryHandleOnlineRef = useRef<(() => void) | null>(null);
  const reconnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Exponential backoff state for "another client holds the room"
  // (`active-session`) reconnect retries: 3 s × 2^attempt, capped at
  // 60 s. Reset on every loop-exit path in handleOnline and on
  // documentId change in the load effect.
  const activeSessionRetryAttemptRef = useRef(0);
  const resetOfflineEditor = useCallback(() => {
    offlineEditorRef.current = null;
    setOfflineEditor(null);
  }, []);

  // On mount, load any cached snapshot. Online startup only restores a
  // recovery session that belongs to this tab; otherwise the cache remains a
  // plain offline fallback and normal sync starts immediately.
  useEffect(() => {
    activeSessionRetryAttemptRef.current = 0;
    let cancelled = false;
    Promise.all([
      getSyncCache(documentId),
      getSyncRecovery(documentId, currentSessionId),
    ])
      .then(([cacheEntry, recoveryEntry]) => {
        if (cancelled) return;
        snapshotVersionRef.current =
          recoveryEntry?.snapshotVersion ?? cacheEntry?.snapshotVersion ?? 0;
        const startupState = resolveStartupState({
          cacheEntry,
          recoveryEntry,
          isOnline: navigator.onLine,
        });

        if (startupState.type === "offline") {
          resetOfflineEditor();
          shouldAutoReconnectRef.current = startupState.shouldAutoReconnect;
          setMode({
            type: "offline",
            snapshot: startupState.snapshot,
            recovery: startupState.recovery,
          });
          return;
        }

        if (startupState.type === "reconnecting") {
          resetOfflineEditor();
          shouldAutoReconnectRef.current = true;
          setMode(startupState);
          return;
        }

        setMode(startupState);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load cached synced snapshot", error);
        setMode(
          navigator.onLine ? { type: "synced" } : { type: "unavailable" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, documentId, resetOfflineEditor]);

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
    if (mode.type !== "offline" && mode.type !== "reconnecting") return;

    // The synced repo is bound to a workspace at login. If somehow we
    // got here without one (logged out mid-flow, race during workspace
    // discovery), there's no server to reconcile against — stay
    // offline and let a future reconnect retry the path.
    if (!repository) return;

    const recovery = mode.recovery;
    let snapshot: TLStoreSnapshot = mode.snapshot;

    // Prefer the live offline editor state, but fall back to the cached
    // snapshot restored into offline mode so a fast reconnect before mount
    // does not discard offline edits.
    const editor = mode.type === "offline" ? offlineEditorRef.current : null;
    if (editor) {
      snapshot = getSnapshot(editor.store).document;
    }

    setMode({
      type: "reconnecting",
      snapshot,
      recovery,
    });

    let result: ReconnectResult;
    try {
      result = await reconcileOfflineEdits({
        documentId,
        localSnapshot: snapshot,
        recovery,
        snapshotVersion: snapshotVersionRef.current,
        repository,
      });
    } catch (error) {
      console.error("Offline reconciliation threw unexpectedly:", error);
      activeSessionRetryAttemptRef.current = 0;
      setMode({ type: "offline", snapshot, recovery });
      return;
    }

    if (result.action === "noop") {
      activeSessionRetryAttemptRef.current = 0;
      await deleteSyncRecovery(documentId, currentSessionId);
      setMode({ type: "synced" });
      return;
    }

    if (result.action === "pushed") {
      activeSessionRetryAttemptRef.current = 0;
      const pushedSnapshotState = {
        snapshot,
        snapshotVersion: snapshotVersionRef.current,
        recovery: {
          baselineSnapshot: snapshot,
          reconnectSnapshot: snapshot,
          hasPendingOfflineChanges: false,
        },
      };

      // Preserve the pushed snapshot locally until the synced room republishes
      // its fresh state. A second disconnect in that handoff window should
      // continue from the just-pushed document, not from the stale pre-
      // offline snapshot that may still be sitting in the synced ref.
      liveSyncedSnapshotStateRef.current = pushedSnapshotState;
      await setSyncCache(documentId, {
        snapshot,
        snapshotVersion: snapshotVersionRef.current,
      });
      await deleteSyncRecovery(documentId, currentSessionId);
      setMode({ type: "synced" });
    } else if (result.action === "forked") {
      activeSessionRetryAttemptRef.current = 0;
      await deleteSyncRecovery(documentId, currentSessionId);
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
        const attempt = activeSessionRetryAttemptRef.current;
        const delay = Math.min(3000 * 2 ** attempt, 60000);
        activeSessionRetryAttemptRef.current = attempt + 1;
        reconnectRetryTimerRef.current = setTimeout(() => {
          retryHandleOnlineRef.current?.();
        }, delay);
        setMode({
          type: "reconnecting",
          snapshot,
          recovery,
        });
        return;
      }
      activeSessionRetryAttemptRef.current = 0;
      setMode({
        type: "offline",
        snapshot,
        recovery,
      });
    }
  }, [
    mode,
    documentId,
    currentSessionId,
    refreshDocuments,
    selectDocument,
    repository,
  ]);

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
        resetOfflineEditor();
        setMode({
          type: "offline",
          snapshot: liveSnapshotState.snapshot,
          recovery: liveSnapshotState.recovery,
        });
        snapshotVersionRef.current = liveSnapshotState.snapshotVersion;
        void setSyncCache(currentDocumentId, {
          snapshot: liveSnapshotState.recovery.hasPendingOfflineChanges
            ? liveSnapshotState.recovery.baselineSnapshot
            : liveSnapshotState.snapshot,
          snapshotVersion: liveSnapshotState.snapshotVersion,
        }).catch((error) => {
          console.error(
            "Failed to persist live synced snapshot after disconnect",
            error,
          );
        });
        void setSyncRecovery(
          currentDocumentId,
          {
            snapshot: liveSnapshotState.snapshot,
            snapshotVersion: liveSnapshotState.snapshotVersion,
            recovery: createRecoveryState({
              ...liveSnapshotState.recovery,
            }),
          },
          currentSessionId,
        ).catch((error) => {
          console.error(
            "Failed to persist live recovery snapshot after disconnect",
            error,
          );
        });
        return;
      }

      Promise.all([
        getSyncCache(currentDocumentId),
        getSyncRecovery(currentDocumentId, currentSessionId),
      ])
        .then(([cacheEntry, recoveryEntry]) => {
          if (cacheEntry || recoveryEntry) {
            snapshotVersionRef.current =
              recoveryEntry?.snapshotVersion ??
              cacheEntry?.snapshotVersion ??
              0;
            resetOfflineEditor();
            const startupState = resolveStartupState({
              cacheEntry,
              recoveryEntry,
              isOnline: false,
            });
            if (startupState.type === "offline") {
              setMode({
                type: "offline",
                snapshot: startupState.snapshot,
                recovery: startupState.recovery,
              });
              return;
            }
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

    // This intentionally follows the browser's network state. Wider sync
    // failures while the browser still reports online should be handled by a
    // separate, debounced signal from SyncedAnipresContainer's useSync status.
    window.addEventListener("offline", handleOffline);
    return () => window.removeEventListener("offline", handleOffline);
  }, [currentSessionId, documentId, mode.type, resetOfflineEditor]);

  useEffect(() => {
    if (
      !shouldAutoReconnectRef.current ||
      !navigator.onLine ||
      mode.type !== "reconnecting"
    ) {
      return;
    }

    shouldAutoReconnectRef.current = false;
    const timer = setTimeout(() => {
      void handleOnline();
    }, 0);

    return () => clearTimeout(timer);
  }, [handleOnline, mode.type]);

  const handleOfflineMount = useCallback((editor: Editor) => {
    offlineEditorRef.current = editor;
    setOfflineEditor(editor);
  }, []);

  // Extract the offline recovery state so the effect's dep array can
  // reference a flat variable instead of a conditional expression —
  // required by react-hooks/exhaustive-deps.
  const offlineRecovery = mode.type === "offline" ? mode.recovery : undefined;

  useEffect(() => {
    if (!offlineEditor || !offlineRecovery) {
      return;
    }

    const flush = async () => {
      const snapshot = getSnapshot(offlineEditor.store).document;
      await setSyncRecovery(
        documentId,
        {
          snapshot,
          snapshotVersion: snapshotVersionRef.current,
          recovery: createRecoveryState({
            ...offlineRecovery,
            hasPendingOfflineChanges: true,
          }),
        },
        currentSessionId,
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
  }, [currentSessionId, documentId, offlineRecovery, offlineEditor]);

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

  if (mode.type === "offline" || mode.type === "reconnecting") {
    const isReconnecting = mode.type === "reconnecting";
    // Use the document id alone as the React key so the same Anipres /
    // tldraw instance persists across offline ↔ reconnecting transitions.
    // Without this the editor would unmount/remount on every transition,
    // discarding camera position, selection, and any open dropdowns.
    // handleOfflineMount stays attached in both modes so the offline
    // editor ref is populated regardless of which mode mounted first
    // (e.g., the startup branch can land directly in "reconnecting").
    return (
      <>
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            background: isReconnecting ? "#3b82f6" : "#f59e0b",
            color: isReconnecting ? "#fff" : "#000",
            padding: "4px 16px",
            borderRadius: "0 0 6px 6px",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {isReconnecting ? "Reconnecting…" : "Offline — changes saved locally"}
        </div>
        <Anipres
          key={documentId}
          snapshot={mode.snapshot}
          onMount={handleOfflineMount}
          colorScheme={colorScheme}
          maxAssetSize={MAX_ASSET_SIZE}
        />
      </>
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
