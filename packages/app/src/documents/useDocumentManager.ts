import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta, DocumentOrigin } from "./types";

function createNewDocument(
  order: number,
  origin: DocumentOrigin,
): DocumentData {
  return {
    meta: {
      id: crypto.randomUUID(),
      title: "Untitled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order,
      origin,
    },
    snapshot: null,
  };
}

export interface DocumentManager {
  documents: DocumentMeta[];
  activeDocument: DocumentMeta | null;
  activeDocumentId: string | null;
  activeSnapshot: TLStoreSnapshot | null;
  loading: boolean;
  selectDocument: (id: string) => Promise<void>;
  createDocument: (options?: { origin?: DocumentOrigin }) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, title: string) => Promise<void>;
  reorderDocument: (id: string, newOrder: number) => Promise<void>;
  registerEditor: (editor: Editor) => () => void;
  refreshDocuments: () => Promise<void>;
}

export function useDocumentManager(params: {
  localRepository: DocumentRepository;
  syncedRepository?: DocumentRepository;
}): DocumentManager {
  const { localRepository, syncedRepository } = params;

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

  const documentsRef = useRef<DocumentMeta[]>(documents);
  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  const activeDocument = useMemo(
    () => documents.find((d) => d.id === activeDocumentId) ?? null,
    [documents, activeDocumentId],
  );
  const activeDocumentOriginRef = useRef<DocumentOrigin | null>(null);
  useEffect(() => {
    activeDocumentOriginRef.current = activeDocument?.origin ?? null;
  }, [activeDocument]);

  // Resolve which repository owns a given document id by consulting the
  // latest merged list. Falls back to the implicit "local only" repo when
  // called before the first load settles.
  const getRepository = useCallback(
    (origin: DocumentOrigin | undefined): DocumentRepository | null => {
      if (origin === "synced") return syncedRepository ?? null;
      return localRepository;
    },
    [localRepository, syncedRepository],
  );
  const findRepositoryForId = useCallback(
    (id: string): DocumentRepository | null => {
      const meta = documentsRef.current.find((d) => d.id === id);
      return getRepository(meta?.origin);
    },
    [getRepository],
  );

  const listAllDocuments = useCallback(async (): Promise<DocumentMeta[]> => {
    const syncedList = syncedRepository
      ? await syncedRepository.list()
      : ([] as DocumentMeta[]);
    const localList = await localRepository.list();
    // Synced first, then local. Each group is already ordered by `order`
    // from its repository.
    return [...syncedList, ...localList];
  }, [localRepository, syncedRepository]);

  const saveCurrentEditor = useCallback(async () => {
    // Only local-origin documents are persisted via this hook — synced
    // documents are persisted by useSync over WebSocket.
    if (activeDocumentOriginRef.current !== "local") return;

    const editor = editorRef.current;
    const docId = activeDocumentIdRef.current;
    if (!editor || !docId) return;

    const existing = await localRepository.get(docId);
    if (!existing) return;

    const { document } = getSnapshot(editor.store);
    await localRepository.save({
      ...existing,
      meta: { ...existing.meta, updatedAt: Date.now() },
      snapshot: document,
    });
  }, [localRepository]);

  // Initialize: load documents or create first one
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const metas = await listAllDocuments();
      if (cancelled) return;

      if (metas.length === 0) {
        // Prefer creating the first document in the synced repo when the
        // user is logged in; otherwise create it locally.
        const defaultOrigin: DocumentOrigin = syncedRepository
          ? "synced"
          : "local";
        const repo = getRepository(defaultOrigin);
        if (!repo) return;
        const doc = createNewDocument(1, defaultOrigin);
        await repo.save(doc);
        if (cancelled) return;
        setDocuments([doc.meta]);
        setActiveDocumentId(doc.meta.id);
        setActiveSnapshot(null);
      } else {
        setDocuments(metas);
        const firstMeta = metas[0];
        const repo = getRepository(firstMeta.origin);
        const data = repo ? await repo.get(firstMeta.id) : undefined;
        if (cancelled) return;
        setActiveDocumentId(firstMeta.id);
        setActiveSnapshot(data?.snapshot ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [getRepository, listAllDocuments, syncedRepository]);

  const refreshDocuments = useCallback(async () => {
    const metas = await listAllDocuments();
    setDocuments(metas);
  }, [listAllDocuments]);

  const selectDocument = useCallback(
    async (id: string) => {
      if (id === activeDocumentIdRef.current) return;

      // Save current before switching
      await saveCurrentEditor();

      const repo = findRepositoryForId(id);
      if (!repo) return;

      const data = await repo.get(id);
      if (!data) return;

      editorRef.current = null;
      setActiveDocumentId(id);
      setActiveSnapshot(data.snapshot);
    },
    [findRepositoryForId, saveCurrentEditor],
  );

  const createDocument = useCallback(
    async (options?: { origin?: DocumentOrigin }) => {
      await saveCurrentEditor();

      const origin: DocumentOrigin =
        options?.origin ?? (syncedRepository ? "synced" : "local");
      const repo = getRepository(origin);
      if (!repo) return;

      // Compute order against just this repo's docs so each group stays
      // independently ordered.
      const existing = await repo.list();
      const maxOrder = existing.reduce((max, d) => Math.max(max, d.order), 0);
      const doc = createNewDocument(maxOrder + 1, origin);
      await repo.save(doc);

      editorRef.current = null;
      setActiveDocumentId(doc.meta.id);
      setActiveSnapshot(null);
      await refreshDocuments();
    },
    [getRepository, refreshDocuments, saveCurrentEditor, syncedRepository],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      const repo = findRepositoryForId(id);
      if (!repo) return;

      await repo.delete(id);
      const remaining = await listAllDocuments();

      if (remaining.length === 0) {
        // Create a new document if we deleted the last one; use the
        // current default origin.
        const defaultOrigin: DocumentOrigin = syncedRepository
          ? "synced"
          : "local";
        const defaultRepo = getRepository(defaultOrigin);
        if (!defaultRepo) return;
        const doc = createNewDocument(1, defaultOrigin);
        await defaultRepo.save(doc);
        setDocuments([doc.meta]);
        editorRef.current = null;
        setActiveDocumentId(doc.meta.id);
        setActiveSnapshot(null);
        return;
      }

      setDocuments(remaining);

      if (id === activeDocumentIdRef.current) {
        // Switch to the first remaining document
        const nextMeta = remaining[0];
        const nextRepo = getRepository(nextMeta.origin);
        const data = nextRepo ? await nextRepo.get(nextMeta.id) : undefined;
        editorRef.current = null;
        setActiveDocumentId(nextMeta.id);
        setActiveSnapshot(data?.snapshot ?? null);
      }
    },
    [findRepositoryForId, getRepository, listAllDocuments, syncedRepository],
  );

  const renameDocument = useCallback(
    async (id: string, title: string) => {
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }
      const repo = findRepositoryForId(id);
      if (!repo) return;
      const data = await repo.get(id);
      if (!data) return;
      await repo.save({
        ...data,
        meta: { ...data.meta, title, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [findRepositoryForId, refreshDocuments, saveCurrentEditor],
  );

  const reorderDocument = useCallback(
    async (id: string, newOrder: number) => {
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }
      const repo = findRepositoryForId(id);
      if (!repo) return;
      const data = await repo.get(id);
      if (!data) return;
      await repo.save({
        ...data,
        meta: { ...data.meta, order: newOrder, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [findRepositoryForId, refreshDocuments, saveCurrentEditor],
  );

  const registerEditor = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      // Synced documents are persisted by useSync; this auto-save path is
      // only for local-origin docs. The check is re-evaluated on every
      // store event below so switching the active doc takes effect without
      // re-registering.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopListening = editor.store.listen(
        () => {
          if (activeDocumentOriginRef.current !== "local") return;
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
    [saveCurrentEditor],
  );

  // Best-effort save when the user leaves the page.
  // visibilitychange fires earliest (e.g. tab switch, app switch) and is
  // bfcache-compatible. pagehide and beforeunload are fallbacks for actual
  // navigation/close. None of these can await the async save, but firing it
  // initiates the IndexedDB transaction which browsers typically allow to
  // complete during page teardown.
  // No-op for synced docs — content is persisted by useSync.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        activeDocumentOriginRef.current === "local" &&
        document.visibilityState === "hidden"
      ) {
        saveCurrentEditor();
      }
    };
    const handlePageHide = () => {
      if (activeDocumentOriginRef.current === "local") saveCurrentEditor();
    };
    const handleBeforeUnload = () => {
      if (activeDocumentOriginRef.current === "local") saveCurrentEditor();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [saveCurrentEditor]);

  return {
    documents,
    activeDocument,
    activeDocumentId,
    activeSnapshot,
    loading,
    selectDocument,
    createDocument,
    deleteDocument,
    renameDocument,
    reorderDocument,
    registerEditor,
    refreshDocuments,
  };
}
