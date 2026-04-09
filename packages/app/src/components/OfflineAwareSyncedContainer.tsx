import { useCallback, useEffect, useRef, useState } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import { Anipres } from "anipres";
import { SyncedAnipresContainer } from "./SyncedAnipresContainer";
import { getSyncCache, deleteSyncCache } from "../documents/idb-sync-cache";
import { reconcileOfflineEdits } from "../documents/reconnect";
import { ApiDocumentRepository } from "../documents/api-repository";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";

type Mode =
  | { type: "synced" }
  | { type: "offline"; snapshot: TLStoreSnapshot }
  | { type: "reconnecting" }
  | { type: "unavailable" };

interface OfflineAwareSyncedContainerProps {
  documentId: string;
  colorScheme?: "light" | "dark" | "system";
}

const repository = new ApiDocumentRepository();

export function OfflineAwareSyncedContainer({
  documentId,
  colorScheme,
}: OfflineAwareSyncedContainerProps) {
  const [mode, setMode] = useState<Mode>(() =>
    navigator.onLine ? { type: "synced" } : { type: "unavailable" },
  );
  const { refreshDocuments, selectDocument } = useDocumentManagerContext();

  // Track the offline editor so we can grab its snapshot for reconciliation.
  const offlineEditorRef = useRef<Editor | null>(null);
  const cachedAtRef = useRef<number>(0);

  // On mount when offline, try to load from IDB cache.
  useEffect(() => {
    if (navigator.onLine) return;

    let cancelled = false;
    getSyncCache(documentId).then((entry) => {
      if (cancelled) return;
      if (entry) {
        cachedAtRef.current = entry.cachedAt;
        setMode({ type: "offline", snapshot: entry.snapshot });
      } else {
        setMode({ type: "unavailable" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  // Listen for online event to trigger reconnection.
  const handleOnline = useCallback(async () => {
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

    const result = await reconcileOfflineEdits({
      documentId,
      localSnapshot: snapshot,
      cachedAt: cachedAtRef.current,
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
      setMode({ type: "offline", snapshot });
    }
  }, [mode.type, documentId, refreshDocuments, selectDocument]);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [handleOnline]);

  const handleOfflineMount = useCallback((editor: Editor) => {
    offlineEditorRef.current = editor;
  }, []);

  if (mode.type === "synced") {
    return (
      <SyncedAnipresContainer
        documentId={documentId}
        colorScheme={colorScheme}
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
