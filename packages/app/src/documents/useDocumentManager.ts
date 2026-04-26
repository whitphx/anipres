import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta, DocumentOrigin } from "./types";
import {
  convertLocalDocToSynced,
  type ConvertLocalDocToSyncedParams,
} from "./migration";
import { nextTailSortOrder } from "./sort-order";

function createNewDocument(
  sortOrder: string,
  origin: DocumentOrigin,
): DocumentData {
  return {
    meta: {
      id: crypto.randomUUID(),
      title: "Untitled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sortOrder,
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
  /** Document ids currently being migrated via convertToSynced. */
  converting: ReadonlySet<string>;
  /**
   * Errors from the most recent convertToSynced attempts, keyed by
   * document id. An entry is present only after a failed attempt and
   * cleared when the same id is retried.
   */
  conversionErrors: ReadonlyMap<string, Error>;
  selectDocument: (id: string) => Promise<void>;
  createDocument: (options?: { origin?: DocumentOrigin }) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, title: string) => Promise<void>;
  reorderDocument: (id: string, newSortOrder: string) => Promise<void>;
  convertToSynced: (id: string) => Promise<void>;
  registerEditor: (editor: Editor) => () => void;
  refreshDocuments: () => Promise<void>;
}

export type MigrationOverrides = Pick<
  ConvertLocalDocToSyncedParams,
  "uploadAsset" | "pushSnapshot"
>;

export function useDocumentManager(params: {
  localRepository: DocumentRepository;
  syncedRepository?: DocumentRepository;
  /**
   * Optional test/dev injection point for the HTTP calls that
   * convertLocalDocToSynced performs. Production callers leave this
   * undefined and the default fetch-based implementations are used.
   */
  migrationOverrides?: MigrationOverrides;
}): DocumentManager {
  const { localRepository, syncedRepository, migrationOverrides } = params;

  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeSnapshot, setActiveSnapshot] = useState<TLStoreSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [converting, setConverting] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [conversionErrors, setConversionErrors] = useState<
    ReadonlyMap<string, Error>
  >(() => new Map());

  const editorRef = useRef<Editor | null>(null);
  // Mirror of `converting` readable synchronously inside convertToSynced
  // so a per-id gate can reject a second call on the same doc without the
  // stale-closure trap of reading React state.
  const convertingRef = useRef<ReadonlySet<string>>(converting);
  // AbortController per in-flight convert-to-synced migration. Populated
  // in convertToSynced, consumed by deleteDocument to cancel a migration
  // when the local doc it is operating on is deleted mid-flight.
  const migrationAbortControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );

  // Keep refs in sync with state via a pair of commit helpers so actions
  // that run immediately after a state change (e.g. selecting a
  // freshly-forked doc after refreshDocuments, or reading the active
  // doc's origin from a store listener right after a doc switch) can see
  // the updated values before React commits the next render.
  const documentsRef = useRef<DocumentMeta[]>(documents);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeDocumentOriginRef = useRef<DocumentOrigin | null>(null);

  const syncActiveOriginRef = (
    nextDocs: DocumentMeta[],
    activeId: string | null,
  ) => {
    activeDocumentOriginRef.current = activeId
      ? (nextDocs.find((d) => d.id === activeId)?.origin ?? null)
      : null;
  };

  const commitDocuments = useCallback((next: DocumentMeta[]) => {
    documentsRef.current = next;
    syncActiveOriginRef(next, activeDocumentIdRef.current);
    setDocuments(next);
  }, []);

  const commitActiveDocumentId = useCallback((next: string | null) => {
    activeDocumentIdRef.current = next;
    syncActiveOriginRef(documentsRef.current, next);
    setActiveDocumentId(next);
  }, []);

  const activeDocument = useMemo(
    () => documents.find((d) => d.id === activeDocumentId) ?? null,
    [documents, activeDocumentId],
  );

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
    // Load both lists in parallel. On synced-list failure (server down,
    // offline after auth) fall back to the last known synced docs from
    // documentsRef, so a transient failure during a post-operation
    // refresh does not silently drop synced documents from the sidebar
    // and unmount the active synced editor. On initial load the ref is
    // still empty, so that case degrades to an empty synced group as
    // before. A local-list failure still propagates because it signals
    // an IndexedDB-level problem that the caller needs to surface.
    const [syncedList, localList] = await Promise.all([
      syncedRepository
        ? syncedRepository.list().catch((error) => {
            console.error("Failed to list synced documents", error);
            return documentsRef.current.filter((d) => d.origin === "synced");
          })
        : Promise.resolve([] as DocumentMeta[]),
      localRepository.list(),
    ]);
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
    await localRepository.update({
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
        const draft = createNewDocument(nextTailSortOrder([]), defaultOrigin);
        // The synced repo allocates a server-side id at create; use the
        // returned doc's id rather than the draft's UUID.
        const saved = await repo.create(draft);
        if (cancelled) return;
        commitDocuments([saved.meta]);
        commitActiveDocumentId(saved.meta.id);
        setActiveSnapshot(null);
      } else {
        commitDocuments(metas);
        const firstMeta = metas[0];
        const repo = getRepository(firstMeta.origin);
        const data = repo ? await repo.get(firstMeta.id) : undefined;
        if (cancelled) return;
        commitActiveDocumentId(firstMeta.id);
        setActiveSnapshot(data?.snapshot ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    commitActiveDocumentId,
    commitDocuments,
    getRepository,
    listAllDocuments,
    syncedRepository,
  ]);

  const refreshDocuments = useCallback(async () => {
    const metas = await listAllDocuments();
    commitDocuments(metas);
  }, [commitDocuments, listAllDocuments]);

  // When the syncedRepository identity changes — login, logout, or a
  // logout-then-login cycle — any in-flight migration state is about to
  // become meaningless. Reset so no row inherits a ghost spinner or
  // stale error from the prior repository pair.
  const prevSyncedRepoRef = useRef<DocumentRepository | undefined>(
    syncedRepository,
  );
  useEffect(() => {
    if (prevSyncedRepoRef.current === syncedRepository) return;
    prevSyncedRepoRef.current = syncedRepository;
    convertingRef.current = new Set();
    setConverting(new Set());
    setConversionErrors(new Map());
  }, [syncedRepository]);

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
      commitActiveDocumentId(id);
      setActiveSnapshot(data.snapshot);
    },
    [commitActiveDocumentId, findRepositoryForId, saveCurrentEditor],
  );

  const createDocument = useCallback(
    async (options?: { origin?: DocumentOrigin }) => {
      await saveCurrentEditor();

      const origin: DocumentOrigin =
        options?.origin ?? (syncedRepository ? "synced" : "local");
      const repo = getRepository(origin);
      if (!repo) return;

      // Compute the next sort_order key against just this repo's docs
      // so each group stays independently ordered. Catch repository
      // failures (e.g. synced server unreachable) so the button click
      // doesn't end in an unhandled rejection with no user-visible
      // change.
      try {
        const existing = await repo.list();
        const draft = createNewDocument(nextTailSortOrder(existing), origin);
        const saved = await repo.create(draft);

        editorRef.current = null;
        commitActiveDocumentId(saved.meta.id);
        setActiveSnapshot(null);
        await refreshDocuments();
      } catch (error) {
        console.error(`Failed to create ${origin} document`, error);
      }
    },
    [
      commitActiveDocumentId,
      getRepository,
      refreshDocuments,
      saveCurrentEditor,
      syncedRepository,
    ],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      const repo = findRepositoryForId(id);
      if (!repo) return;

      // Cancel any in-flight convert-to-synced migration for this id
      // before touching storage. The migration's catch handler will see
      // controller.signal.aborted and exit silently.
      //
      // With server-allocated ids, the local id we have here doesn't
      // match the server-side row's id (the server allocated its own
      // INTEGER at POST time). Cleaning up a half-migrated server doc
      // would require tracking the server-allocated id from inside
      // the migration — deliberately deferred. If the user deletes
      // mid-migration *and* the server doc was already created, the
      // user will see a leftover row on the next refresh and can
      // delete it manually. Acceptable for the rare race window.
      const migrationController = migrationAbortControllersRef.current.get(id);
      if (migrationController) {
        migrationController.abort();
        migrationAbortControllersRef.current.delete(id);
      }

      await repo.delete(id);

      // Drop any stale convert-to-synced state for this id. An entry in
      // conversionErrors would otherwise linger in memory with no row to
      // render against; an in-flight converting entry is also removed
      // immediately so the spinner disappears without waiting for the
      // migration to respond to the abort.
      setConversionErrors((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      if (convertingRef.current.has(id)) {
        const next = new Set(convertingRef.current);
        next.delete(id);
        convertingRef.current = next;
        setConverting(next);
      }

      const remaining = await listAllDocuments();

      if (remaining.length === 0) {
        // Create a new document if we deleted the last one; use the
        // current default origin. Fall back to local creation if the
        // preferred (synced) save fails so the user is not left with an
        // empty sidebar after a successful delete.
        const defaultOrigin: DocumentOrigin = syncedRepository
          ? "synced"
          : "local";
        const defaultRepo = getRepository(defaultOrigin);
        if (!defaultRepo) return;
        const draft = createNewDocument(nextTailSortOrder([]), defaultOrigin);
        let saved: DocumentData;
        try {
          saved = await defaultRepo.create(draft);
        } catch (error) {
          console.error(
            `Failed to create replacement ${defaultOrigin} document; falling back to local`,
            error,
          );
          if (defaultOrigin === "synced") {
            const localDraft = createNewDocument(
              nextTailSortOrder([]),
              "local",
            );
            try {
              saved = await localRepository.create(localDraft);
            } catch (localError) {
              console.error(
                "Failed to create replacement local document",
                localError,
              );
              return;
            }
          } else {
            return;
          }
        }
        commitDocuments([saved.meta]);
        editorRef.current = null;
        commitActiveDocumentId(saved.meta.id);
        setActiveSnapshot(null);
        return;
      }

      commitDocuments(remaining);

      if (id === activeDocumentIdRef.current) {
        // Switch to the first remaining document
        const nextMeta = remaining[0];
        const nextRepo = getRepository(nextMeta.origin);
        const data = nextRepo ? await nextRepo.get(nextMeta.id) : undefined;
        editorRef.current = null;
        commitActiveDocumentId(nextMeta.id);
        setActiveSnapshot(data?.snapshot ?? null);
      }
    },
    [
      commitActiveDocumentId,
      commitDocuments,
      findRepositoryForId,
      getRepository,
      listAllDocuments,
      localRepository,
      syncedRepository,
    ],
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
      await repo.update({
        ...data,
        meta: { ...data.meta, title, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [findRepositoryForId, refreshDocuments, saveCurrentEditor],
  );

  const reorderDocument = useCallback(
    async (id: string, newSortOrder: string) => {
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }
      const repo = findRepositoryForId(id);
      if (!repo) return;
      const data = await repo.get(id);
      if (!data) return;
      await repo.update({
        ...data,
        meta: { ...data.meta, sortOrder: newSortOrder, updatedAt: Date.now() },
      });
      await refreshDocuments();
    },
    [findRepositoryForId, refreshDocuments, saveCurrentEditor],
  );

  const convertToSynced = useCallback(
    async (id: string) => {
      if (!syncedRepository) return;
      // Per-id gate: a second call for the same doc while it is still in
      // flight is a no-op. Migrations on different docs are allowed to
      // run concurrently.
      if (convertingRef.current.has(id)) return;
      // Filter to the local entry specifically. After a partial failure
      // (server save succeeded but snapshot push or asset upload failed)
      // both a local and a synced entry can briefly share the same id;
      // returning the first match would otherwise pick the synced one
      // and silently block the retry.
      const meta = documentsRef.current.find(
        (d) => d.id === id && d.origin === "local",
      );
      if (!meta) return;

      // Flush any pending editor state for this doc before migrating so
      // convertLocalDocToSynced picks up the latest snapshot from IDB.
      if (id === activeDocumentIdRef.current) {
        await saveCurrentEditor();
      }

      // Mark this doc as in-flight and clear any prior error on it before
      // any async work so the UI flips to the spinner synchronously.
      // Other docs' in-flight / error state is left intact.
      const nextConverting = new Set(convertingRef.current);
      nextConverting.add(id);
      convertingRef.current = nextConverting;
      setConverting(nextConverting);
      setConversionErrors((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });

      // Register an AbortController for this migration so deleteDocument
      // can cancel it if the user deletes the doc mid-flight.
      const controller = new AbortController();
      migrationAbortControllersRef.current.set(id, controller);

      const clearInFlight = () => {
        migrationAbortControllersRef.current.delete(id);
        const next = new Set(convertingRef.current);
        next.delete(id);
        convertingRef.current = next;
        setConverting(next);
      };

      let migrated: DocumentData;
      try {
        migrated = await convertLocalDocToSynced({
          documentId: id,
          localRepository,
          syncedRepository,
          ...migrationOverrides,
          abortSignal: controller.signal,
        });
      } catch (error) {
        clearInFlight();
        if (controller.signal.aborted) {
          // The migration was cancelled from deleteDocument. That path
          // has already run its own cleanup (local delete, synced
          // metadata cleanup, listAllDocuments), so don't double-log,
          // surface an error, or refresh again.
          return;
        }
        console.error("Failed to convert document to synced", error);
        setConversionErrors((prev) => {
          const next = new Map(prev);
          next.set(
            id,
            error instanceof Error ? error : new Error(String(error)),
          );
          return next;
        });
        // Refresh in case the server metadata was created before the
        // failure; the local copy is intentionally preserved by
        // convertLocalDocToSynced so the user can retry.
        await refreshDocuments();
        return;
      }

      clearInFlight();
      await refreshDocuments();

      // The converted doc gets a server-allocated id (different from
      // the local UUID). If the active doc is the one we just
      // migrated, swap to the new id so the editor key updates and
      // the synced container takes over.
      if (id === activeDocumentIdRef.current) {
        editorRef.current = null;
        commitActiveDocumentId(migrated.meta.id);
      }
    },
    [
      commitActiveDocumentId,
      localRepository,
      migrationOverrides,
      refreshDocuments,
      saveCurrentEditor,
      syncedRepository,
    ],
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
    converting,
    conversionErrors,
    selectDocument,
    createDocument,
    deleteDocument,
    renameDocument,
    reorderDocument,
    convertToSynced,
    registerEditor,
    refreshDocuments,
  };
}
