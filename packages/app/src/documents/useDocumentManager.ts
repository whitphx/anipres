import { useState, useEffect, useCallback, useRef } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta } from "./types";

function createNewDocument(order: number): DocumentData {
  return {
    meta: {
      id: crypto.randomUUID(),
      title: "Untitled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order,
    },
    snapshot: null,
  };
}

export interface DocumentManager {
  documents: DocumentMeta[];
  activeDocumentId: string | null;
  activeSnapshot: TLStoreSnapshot | null;
  loading: boolean;
  synced: boolean;
  selectDocument: (id: string) => Promise<void>;
  createDocument: () => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, title: string) => Promise<void>;
  reorderDocument: (id: string, newOrder: number) => Promise<void>;
  registerEditor: (editor: Editor) => () => void;
}

export function useDocumentManager(
  repository: DocumentRepository,
  options?: { synced?: boolean },
): DocumentManager {
  const synced = options?.synced ?? false;
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<TLStoreSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const editorRef = useRef<Editor | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeDocumentIdRef.current = activeDocumentId;
  }, [activeDocumentId]);

  const saveCurrentEditor = useCallback(async () => {
    if (synced) return;

    const editor = editorRef.current;
    const docId = activeDocumentIdRef.current;
    if (!editor || !docId) return;

    const existing = await repository.get(docId);
    if (!existing) return;

    const { document } = getSnapshot(editor.store);
    await repository.save({
      ...existing,
      meta: { ...existing.meta, updatedAt: Date.now() },
      snapshot: document,
    });
  }, [repository, synced]);

  // Initialize: load documents or create first one
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const metas = await repository.list();
      if (cancelled) return;

      if (metas.length === 0) {
        const doc = createNewDocument(1);
        await repository.save(doc);
        if (cancelled) return;
        setDocuments([doc.meta]);
        setActiveDocumentId(doc.meta.id);
        setActiveSnapshot(null);
      } else {
        setDocuments(metas);
        const firstId = metas[0].id;
        const data = await repository.get(firstId);
        if (cancelled) return;
        setActiveDocumentId(firstId);
        setActiveSnapshot(data?.snapshot ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const refreshDocuments = useCallback(async () => {
    const metas = await repository.list();
    setDocuments(metas);
  }, [repository]);

  const selectDocument = useCallback(
    async (id: string) => {
      if (id === activeDocumentIdRef.current) return;

      // Save current before switching
      await saveCurrentEditor();

      const data = await repository.get(id);
      if (!data) return;

      editorRef.current = null;
      setActiveDocumentId(id);
      setActiveSnapshot(data.snapshot);
    },
    [repository, saveCurrentEditor],
  );

  const createDocument = useCallback(async () => {
    await saveCurrentEditor();

    const metas = await repository.list();
    const maxOrder = metas.reduce((max, d) => Math.max(max, d.order), 0);
    const doc = createNewDocument(maxOrder + 1);
    await repository.save(doc);

    editorRef.current = null;
    setActiveDocumentId(doc.meta.id);
    setActiveSnapshot(null);
    await refreshDocuments();
  }, [repository, saveCurrentEditor, refreshDocuments]);

  const deleteDocument = useCallback(
    async (id: string) => {
      await repository.delete(id);
      const remaining = await repository.list();

      if (remaining.length === 0) {
        // Create a new document if we deleted the last one
        const doc = createNewDocument(1);
        await repository.save(doc);
        setDocuments([doc.meta]);
        editorRef.current = null;
        setActiveDocumentId(doc.meta.id);
        setActiveSnapshot(null);
        return;
      }

      setDocuments(remaining);

      if (id === activeDocumentIdRef.current) {
        // Switch to the first remaining document
        const nextDoc = remaining[0];
        const data = await repository.get(nextDoc.id);
        editorRef.current = null;
        setActiveDocumentId(nextDoc.id);
        setActiveSnapshot(data?.snapshot ?? null);
      }
    },
    [repository],
  );

  const renameDocument = useCallback(
    async (id: string, title: string) => {
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }
      const data = await repository.get(id);
      if (!data) return;
      await repository.save({
        ...data,
        meta: { ...data.meta, title, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [repository, refreshDocuments, saveCurrentEditor],
  );

  const reorderDocument = useCallback(
    async (id: string, newOrder: number) => {
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }
      const data = await repository.get(id);
      if (!data) return;
      await repository.save({
        ...data,
        meta: { ...data.meta, order: newOrder, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [repository, refreshDocuments, saveCurrentEditor],
  );

  const registerEditor = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      if (synced) {
        return () => {
          // No auto-save listener to clean up in synced mode
        };
      }

      // Auto-save on user changes, debounced
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopListening = editor.store.listen(
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            saveCurrentEditor();
          }, 500);
        },
        { source: "user", scope: "document" },
      );

      return () => {
        clearTimeout(timer);
        stopListening();
      };
    },
    [saveCurrentEditor, synced],
  );

  // Best-effort save when the user leaves the page.
  // visibilitychange fires earliest (e.g. tab switch, app switch) and is
  // bfcache-compatible. pagehide and beforeunload are fallbacks for actual
  // navigation/close. None of these can await the async save, but firing it
  // initiates the IndexedDB transaction which browsers typically allow to
  // complete during page teardown.
  // Skipped in synced mode — content is persisted by useSync.
  useEffect(() => {
    if (synced) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        saveCurrentEditor();
      }
    };
    const handlePageHide = () => {
      saveCurrentEditor();
    };
    const handleBeforeUnload = () => {
      saveCurrentEditor();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [saveCurrentEditor, synced]);

  return {
    documents,
    activeDocumentId,
    activeSnapshot,
    loading,
    synced,
    selectDocument,
    createDocument,
    deleteDocument,
    renameDocument,
    reorderDocument,
    registerEditor,
  };
}
