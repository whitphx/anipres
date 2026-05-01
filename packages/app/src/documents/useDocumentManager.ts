import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getSnapshot, type Editor, type TLStoreSnapshot } from "tldraw";
import { v7 as uuidv7 } from "uuid";
import type { DocumentRepository } from "./repository";
import type {
  DocumentData,
  DocumentInput,
  DocumentMeta,
  DocumentSource,
} from "./types";
import {
  broadcastLocalDocsChanged,
  subscribeToLocalDocsChanges,
} from "./local-docs-broadcast";
import {
  convertLocalDocToSynced,
  type ConvertLocalDocToSyncedParams,
} from "./migration";
import { nextTailSortOrder } from "./sort-order";
import { finalizeSyncedDocument } from "./snapshot-push";

function createNewDocumentInput(
  sortOrder: string,
  source: DocumentSource,
): DocumentInput {
  return {
    meta: {
      // Mint the doc id upfront so callers (and the server, on
      // synced creates) see the same id from the moment the doc
      // exists. v7 keeps client-allocated ids time-monotonic on
      // the server's B-tree.
      id: uuidv7(),
      title: "Untitled",
      sortOrder,
      source,
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
  createDocument: (options?: { source?: DocumentSource }) => Promise<void>;
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
  // doc's source from a store listener right after a doc switch) can see
  // the updated values before React commits the next render.
  const documentsRef = useRef<DocumentMeta[]>(documents);
  const activeDocumentIdRef = useRef<string | null>(null);
  const activeDocumentSourceRef = useRef<DocumentSource | null>(null);

  const syncActiveSourceRef = (
    nextDocs: DocumentMeta[],
    activeId: string | null,
  ) => {
    activeDocumentSourceRef.current = activeId
      ? (nextDocs.find((d) => d.id === activeId)?.source ?? null)
      : null;
  };

  const commitDocuments = useCallback((next: DocumentMeta[]) => {
    documentsRef.current = next;
    syncActiveSourceRef(next, activeDocumentIdRef.current);
    setDocuments(next);
  }, []);

  const commitActiveDocumentId = useCallback((next: string | null) => {
    activeDocumentIdRef.current = next;
    syncActiveSourceRef(documentsRef.current, next);
    setActiveDocumentId(next);
  }, []);

  const activeDocument = useMemo(
    () => documents.find((d) => d.id === activeDocumentId) ?? null,
    [documents, activeDocumentId],
  );

  const getRepository = useCallback(
    (source: DocumentSource | undefined): DocumentRepository | null => {
      if (source === "synced") return syncedRepository ?? null;
      return localRepository;
    },
    [localRepository, syncedRepository],
  );
  const findRepositoryForId = useCallback(
    (id: string): DocumentRepository | null => {
      const meta = documentsRef.current.find((d) => d.id === id);
      return getRepository(meta?.source);
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
            return documentsRef.current.filter((d) => d.source === "synced");
          })
        : Promise.resolve([] as DocumentMeta[]),
      localRepository.list(),
    ]);
    return [...syncedList, ...localList];
  }, [localRepository, syncedRepository]);

  const saveCurrentEditor = useCallback(async () => {
    // Only local-source documents are persisted via this hook — synced
    // documents are persisted by useSync over WebSocket.
    if (activeDocumentSourceRef.current !== "local") return;

    const editor = editorRef.current;
    const docId = activeDocumentIdRef.current;
    if (!editor || !docId) return;

    const existing = await localRepository.get(docId);
    if (!existing) return;

    const { document } = getSnapshot(editor.store);
    await localRepository.save({
      ...existing,
      snapshot: document,
    });
  }, [localRepository]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const metas = await listAllDocuments();
      if (cancelled) return;

      if (metas.length === 0) {
        // Prefer creating the first document in the synced repo when the
        // user is logged in; otherwise create it locally.
        const defaultSource: DocumentSource = syncedRepository
          ? "synced"
          : "local";
        const repo = getRepository(defaultSource);
        if (!repo) return;
        const input = createNewDocumentInput(
          nextTailSortOrder([]),
          defaultSource,
        );
        // The synced repo allocates a server-side id at create; use the
        // returned doc's id rather than the input's UUID.
        const saved = await repo.save(input);
        if (cancelled) return;
        if (defaultSource === "synced") {
          await finalizeSyncedDocument(saved.meta.id);
          if (cancelled) return;
        } else {
          broadcastLocalDocsChanged();
        }
        commitDocuments([saved.meta]);
        commitActiveDocumentId(saved.meta.id);
        setActiveSnapshot(null);
      } else {
        commitDocuments(metas);
        const firstMeta = metas[0];
        const repo = getRepository(firstMeta.source);
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

  // Other tabs in the same browser broadcast on local IDB writes
  // (create / rename / reorder / delete / convert-to-synced). The
  // IDB store itself is shared, so receiving the signal is all this
  // tab needs to pick up the change.
  useEffect(() => {
    return subscribeToLocalDocsChanges(() => {
      void refreshDocuments();
    });
  }, [refreshDocuments]);

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
    async (options?: { source?: DocumentSource }) => {
      await saveCurrentEditor();

      const source: DocumentSource =
        options?.source ?? (syncedRepository ? "synced" : "local");
      const repo = getRepository(source);
      if (!repo) return;

      // Compute the next sort_order key against just this repo's docs
      // so each group stays independently ordered. Catch repository
      // failures (e.g. synced server unreachable) so the button click
      // doesn't end in an unhandled rejection with no user-visible
      // change.
      try {
        const existing = await repo.list();
        const input = createNewDocumentInput(
          nextTailSortOrder(existing),
          source,
        );
        const saved = await repo.save(input);
        if (source === "synced") {
          await finalizeSyncedDocument(saved.meta.id);
        } else {
          broadcastLocalDocsChanged();
        }

        editorRef.current = null;
        commitActiveDocumentId(saved.meta.id);
        setActiveSnapshot(null);
        await refreshDocuments();
      } catch (error) {
        console.error(`Failed to create ${source} document`, error);
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
      const migrationController = migrationAbortControllersRef.current.get(id);
      const wasMigrating = migrationController !== undefined;
      if (migrationController) {
        migrationController.abort();
        migrationAbortControllersRef.current.delete(id);
      }

      await repo.delete(id);
      if (repo === localRepository) {
        broadcastLocalDocsChanged();
      }

      // If the migration's POST already landed before we aborted
      // (step 3 of convertLocalDocToSynced), the server holds a
      // half-finished row at the same id. Best-effort cleanup —
      // a 404 here is fine, it just means the migration hadn't
      // reached step 3 yet. Without this immediate cleanup the
      // server-side sweep would still reap the row after the
      // initializing-grace window, but the user would briefly
      // see a stale entry on the next refresh in the meantime.
      if (wasMigrating && syncedRepository) {
        try {
          await syncedRepository.delete(id);
        } catch (error) {
          console.error(
            `Failed to clean up synced metadata after aborted migration of ${id}`,
            error,
          );
        }
      }

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
        // current default source. Fall back to local creation if the
        // preferred (synced) save fails so the user is not left with an
        // empty sidebar after a successful delete.
        const defaultSource: DocumentSource = syncedRepository
          ? "synced"
          : "local";
        const defaultRepo = getRepository(defaultSource);
        if (!defaultRepo) return;
        const input = createNewDocumentInput(
          nextTailSortOrder([]),
          defaultSource,
        );
        let saved: DocumentData;
        try {
          saved = await defaultRepo.save(input);
          if (defaultSource === "synced") {
            await finalizeSyncedDocument(saved.meta.id);
          } else {
            broadcastLocalDocsChanged();
          }
        } catch (error) {
          console.error(
            `Failed to create replacement ${defaultSource} document; falling back to local`,
            error,
          );
          if (defaultSource === "synced") {
            const localInput = createNewDocumentInput(
              nextTailSortOrder([]),
              "local",
            );
            try {
              saved = await localRepository.save(localInput);
              broadcastLocalDocsChanged();
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
        const nextMeta = remaining[0];
        const nextRepo = getRepository(nextMeta.source);
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
      await repo.save({
        ...data,
        meta: { ...data.meta, title },
      });
      if (repo === localRepository) {
        broadcastLocalDocsChanged();
      }
      await refreshDocuments();
    },
    [findRepositoryForId, localRepository, refreshDocuments, saveCurrentEditor],
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
      await repo.save({
        ...data,
        meta: { ...data.meta, sortOrder: newSortOrder },
      });
      if (repo === localRepository) {
        broadcastLocalDocsChanged();
      }
      await refreshDocuments();
    },
    [findRepositoryForId, localRepository, refreshDocuments, saveCurrentEditor],
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
        (d) => d.id === id && d.source === "local",
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

      try {
        await convertLocalDocToSynced({
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
          // has already run its own cleanup, so don't double-log,
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
        // Refresh in case the server row was created before the
        // failure; the local copy is intentionally preserved by
        // convertLocalDocToSynced so the user can retry.
        await refreshDocuments();
        return;
      }

      clearInFlight();
      await refreshDocuments();

      // The doc keeps its id across the local→synced transition
      // (UUID v7 is client-allocated, see migration docs). If the
      // active doc is the one we just migrated, re-commit the same
      // id so the active-source ref flips from "local" to "synced"
      // and the synced container takes over the editor.
      if (id === activeDocumentIdRef.current) {
        editorRef.current = null;
        commitActiveDocumentId(id);
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
      // only for local-source docs. The check is re-evaluated on every
      // store event below so switching the active doc takes effect without
      // re-registering.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopListening = editor.store.listen(
        () => {
          if (activeDocumentSourceRef.current !== "local") return;
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
        activeDocumentSourceRef.current === "local" &&
        document.visibilityState === "hidden"
      ) {
        saveCurrentEditor();
      }
    };
    const handlePageHide = () => {
      if (activeDocumentSourceRef.current === "local") saveCurrentEditor();
    };
    const handleBeforeUnload = () => {
      if (activeDocumentSourceRef.current === "local") saveCurrentEditor();
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
