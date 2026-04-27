import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { TLStoreSnapshot } from "tldraw";
import { useDocumentManager } from "./useDocumentManager";
import type { DocumentRepository } from "./repository";
import type {
  DocumentData,
  DocumentDraft,
  DocumentMeta,
  DocumentOrigin,
} from "./types";

const emptySnapshot = { store: {}, schema: {} } as unknown as TLStoreSnapshot;

function makeLocalDocWithSnapshot(id: string): DocumentData {
  return {
    meta: {
      id,
      title: id,
      sortOrder: "a0",
      origin: "local",
      createdAt: 0,
      updatedAt: 0,
    },
    snapshot: emptySnapshot,
  };
}

function makeDoc(
  id: string,
  sortOrder: string,
  origin: DocumentOrigin,
  title = id,
): DocumentData {
  return {
    meta: { id, title, sortOrder, origin, createdAt: 0, updatedAt: 0 },
    snapshot: null,
  };
}

function makeFakeRepo(origin: DocumentOrigin, initial: DocumentData[] = []) {
  const store = new Map<string, DocumentData>();
  for (const d of initial) store.set(d.meta.id, d);

  // Each fake stamps `origin` on list/get to mimic the real repo behavior so
  // the hook sees DocumentMeta objects with the correct origin field.
  const list = vi.fn(
    async (): Promise<DocumentMeta[]> =>
      [...store.values()]
        .map((d) => ({ ...d.meta, origin }))
        .sort((a, b) => a.sortOrder.localeCompare(b.sortOrder)),
  );
  const get = vi.fn(async (id: string): Promise<DocumentData | undefined> => {
    const d = store.get(id);
    return d ? { ...d, meta: { ...d.meta, origin } } : undefined;
  });
  // Single upsert method matching the production repo. Both local and
  // synced repos honor the caller's id verbatim — UUID v7 is
  // client-allocated, so the same id flows through every layer and
  // tests can assert on the original id everywhere.
  const save = vi.fn(async (d: DocumentDraft): Promise<DocumentData> => {
    const now = Date.now();
    const existing = store.get(d.meta.id);
    const stored: DocumentData = {
      ...d,
      meta: {
        ...d.meta,
        origin,
        createdAt: existing?.meta.createdAt ?? d.meta.createdAt ?? now,
        updatedAt: now,
      },
    };
    store.set(d.meta.id, stored);
    return stored;
  });
  const del = vi.fn(async (id: string): Promise<void> => {
    store.delete(id);
  });

  const repo: DocumentRepository = {
    list,
    get,
    save,
    delete: del,
  };
  return { repo, store, list, get, save, delete: del };
}

describe("useDocumentManager", () => {
  beforeEach(() => {
    // The hook logs errors intentionally on synced failure paths. Silence
    // them in tests to keep output readable; individual assertions below
    // verify that the log fires when expected via vi.mocked(console.error).
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Synced creation finalizes by pushing an empty initial snapshot via
    // PUT /api/documents/:id/snapshot. Stub fetch so that call resolves
    // OK and tests don't hit a real network.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("merges synced and local documents on initial load with synced first", async () => {
    const localRepo = makeFakeRepo("local", [
      makeDoc("L1", "a0", "local"),
      makeDoc("L2", "a1", "local"),
    ]);
    const syncedRepo = makeFakeRepo("synced", [
      makeDoc("S1", "a0", "synced"),
      makeDoc("S2", "a1", "synced"),
    ]);

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.documents.map((d) => d.id)).toEqual([
      "S1",
      "S2",
      "L1",
      "L2",
    ]);
    expect(result.current.documents.map((d) => d.origin)).toEqual([
      "synced",
      "synced",
      "local",
      "local",
    ]);
  });

  it("creates a first synced document when both repos are empty and logged in", async () => {
    const localRepo = makeFakeRepo("local");
    const syncedRepo = makeFakeRepo("synced");

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(syncedRepo.save).toHaveBeenCalledTimes(1);
    expect(localRepo.save).not.toHaveBeenCalled();
    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0].origin).toBe("synced");
  });

  it("completes initial load with local docs when the synced list rejects", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("L1", "a0", "local")]);
    const syncedRepo = makeFakeRepo("synced");
    syncedRepo.repo.list = vi.fn().mockRejectedValue(new Error("503"));

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.documents.map((d) => d.id)).toEqual(["L1"]);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "Failed to list synced documents",
      expect.any(Error),
    );
  });

  it("preserves the last-known synced list when a later list rejects", async () => {
    const localRepo = makeFakeRepo("local");
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", "a0", "synced")]);

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents.map((d) => d.id)).toContain("S1");

    // Make the next list call fail; refreshDocuments should keep S1 visible.
    syncedRepo.repo.list = vi.fn().mockRejectedValue(new Error("network"));

    await act(async () => {
      await result.current.refreshDocuments();
    });

    expect(result.current.documents.map((d) => d.id)).toContain("S1");
    expect(result.current.activeDocument?.id).toBe("S1");
  });

  it("routes selectDocument to the synced repo immediately after refreshDocuments picks up a new doc", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("L1", "a0", "local")]);
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", "a0", "synced")]);

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Simulate a fork landing server-side between refresh and select — the
    // ref-sync invariant requires that selectDocument sees the new doc
    // immediately, without waiting for React to commit the next render.
    syncedRepo.store.set("S2", makeDoc("S2", "a1", "synced"));

    await act(async () => {
      await result.current.refreshDocuments();
      await result.current.selectDocument("S2");
    });

    expect(syncedRepo.get).toHaveBeenCalledWith("S2");
    expect(localRepo.get).not.toHaveBeenCalledWith("S2");
    expect(result.current.activeDocumentId).toBe("S2");
    expect(result.current.activeDocument?.origin).toBe("synced");
  });

  it("falls back to creating a local replacement when deleting the last doc and synced save fails", async () => {
    const localRepo = makeFakeRepo("local");
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", "a0", "synced")]);

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toHaveLength(1);

    // Synced create fails — the replacement should still land, but as local.
    syncedRepo.repo.save = vi.fn().mockRejectedValue(new Error("server down"));

    await act(async () => {
      await result.current.deleteDocument("S1");
    });

    expect(localRepo.save).toHaveBeenCalledTimes(1);
    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0].origin).toBe("local");
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it("migrates a local doc to synced via convertToSynced and keeps it selected with the new origin", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("doc-1", "a0", "local")]);
    const syncedRepo = makeFakeRepo("synced");

    const uploadAsset = vi.fn();
    const pushSnapshot = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeDocument?.id).toBe("doc-1");
    expect(result.current.activeDocument?.origin).toBe("local");

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    expect(syncedRepo.save).toHaveBeenCalledTimes(1);
    expect(localRepo.delete).toHaveBeenCalledWith("doc-1");
    // The migrated doc keeps its UUID v7 id across the local→synced
    // transition; only the origin flips.
    expect(result.current.activeDocument?.id).toBe("doc-1");
    expect(result.current.activeDocument?.origin).toBe("synced");
  });

  it("exposes converting while a migration is in flight and clears it on completion", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    let resolvePush!: () => void;
    const pushPromise = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockReturnValue(pushPromise);
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.converting.size).toBe(0);

    let convertPromise!: Promise<void>;
    act(() => {
      convertPromise = result.current.convertToSynced("doc-1");
    });

    await waitFor(() =>
      expect(result.current.converting.has("doc-1")).toBe(true),
    );
    expect(result.current.conversionErrors.size).toBe(0);

    await act(async () => {
      resolvePush();
      await convertPromise;
    });

    expect(result.current.converting.size).toBe(0);
    expect(result.current.conversionErrors.size).toBe(0);
  });

  it("runs convertToSynced on two docs in parallel and completes each independently", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
      makeLocalDocWithSnapshot("doc-2"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const resolvers: Record<string, () => void> = {};
    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockImplementation(
        (documentId) =>
          new Promise<void>((resolve) => {
            resolvers[documentId] = resolve;
          }),
      );
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstConvert!: Promise<void>;
    let secondConvert!: Promise<void>;
    act(() => {
      firstConvert = result.current.convertToSynced("doc-1");
      secondConvert = result.current.convertToSynced("doc-2");
    });

    await waitFor(() => {
      expect(result.current.converting.has("doc-1")).toBe(true);
      expect(result.current.converting.has("doc-2")).toBe(true);
    });

    // pushSnapshot receives the same id the local doc had — UUID v7
    // is client-allocated and carries through unchanged.
    await act(async () => {
      resolvers["doc-2"]();
      await secondConvert;
    });

    expect(result.current.converting.has("doc-1")).toBe(true);
    expect(result.current.converting.has("doc-2")).toBe(false);

    await act(async () => {
      resolvers["doc-1"]();
      await firstConvert;
    });

    expect(result.current.converting.size).toBe(0);
    expect(result.current.conversionErrors.size).toBe(0);
  });

  it("no-ops a second convertToSynced on the same doc while the first is still in flight", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    let resolvePush!: () => void;
    const pushPromise = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockReturnValue(pushPromise);
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstConvert!: Promise<void>;
    act(() => {
      firstConvert = result.current.convertToSynced("doc-1");
    });

    await waitFor(() =>
      expect(result.current.converting.has("doc-1")).toBe(true),
    );

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    // Second call did not double-fire the HTTP layer.
    expect(pushSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePush();
      await firstConvert;
    });
  });

  it("surfaces only the failed id in conversionErrors when parallel migrations have mixed outcomes", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-ok"),
      makeLocalDocWithSnapshot("doc-bad"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockImplementation(async (documentId) => {
        // pushSnapshot receives the same id the local doc had — UUID v7
        // is client-allocated and unchanged across the migration.
        if (documentId === "doc-bad") {
          throw new Error("Snapshot push failed: 413");
        }
      });
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await Promise.all([
        result.current.convertToSynced("doc-ok"),
        result.current.convertToSynced("doc-bad"),
      ]);
    });

    expect(result.current.converting.size).toBe(0);
    expect(result.current.conversionErrors.has("doc-ok")).toBe(false);
    expect(result.current.conversionErrors.get("doc-bad")?.message).toMatch(
      /413/,
    );
  });

  it("sets conversionError when the migration fails and keeps the local copy", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockRejectedValue(new Error("Snapshot push failed: 500"));
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    expect(result.current.converting.has("doc-1")).toBe(false);
    expect(result.current.conversionErrors.get("doc-1")?.message).toMatch(
      /500/,
    );
    expect(localRepo.delete).not.toHaveBeenCalled();
  });

  it("clears prior conversionError on retry and completes the migration on success", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Snapshot push failed: 500"))
      .mockResolvedValueOnce(undefined);
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    expect(result.current.conversionErrors.has("doc-1")).toBe(true);

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    expect(result.current.converting.has("doc-1")).toBe(false);
    expect(result.current.conversionErrors.has("doc-1")).toBe(false);
    expect(pushSnapshot).toHaveBeenCalledTimes(2);
    expect(localRepo.delete).toHaveBeenCalledWith("doc-1");
    expect(result.current.activeDocument?.origin).toBe("synced");
  });

  it("clears conversionErrors for a doc when it is deleted", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
      makeLocalDocWithSnapshot("doc-2"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockRejectedValue(new Error("Snapshot push failed: 500"));
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });
    expect(result.current.conversionErrors.has("doc-1")).toBe(true);

    await act(async () => {
      await result.current.deleteDocument("doc-1");
    });

    expect(result.current.conversionErrors.has("doc-1")).toBe(false);
  });

  it("aborts an in-flight migration and cleans up synced metadata when the doc is deleted", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
      makeLocalDocWithSnapshot("doc-2"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    let resolvePush!: () => void;
    const pushPromise = new Promise<void>((resolve) => {
      resolvePush = resolve;
    });
    const pushSnapshot = vi
      .fn<
        (
          documentId: string,
          snapshot: TLStoreSnapshot,
          abortSignal?: AbortSignal,
        ) => Promise<void>
      >()
      .mockImplementation(
        (_docId, _snap, abortSignal) =>
          new Promise<void>((resolve, reject) => {
            // Reject with an AbortError if/when the signal fires.
            abortSignal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted via test signal", "AbortError")),
            );
            // Otherwise wait for the explicit resolve.
            pushPromise.then(resolve, reject);
          }),
      );
    const uploadAsset = vi.fn();

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        migrationOverrides: { uploadAsset, pushSnapshot },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let convertPromise!: Promise<void>;
    act(() => {
      convertPromise = result.current.convertToSynced("doc-1");
    });

    // Wait until the synced metadata save has landed so we know the
    // deletion has something to clean up.
    await waitFor(() => {
      expect(result.current.converting.has("doc-1")).toBe(true);
      expect(syncedRepo.save).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.deleteDocument("doc-1");
      await convertPromise;
    });

    // The aborted migration should not have surfaced as an error and
    // the in-flight state is gone.
    expect(result.current.converting.has("doc-1")).toBe(false);
    expect(result.current.conversionErrors.has("doc-1")).toBe(false);

    // With UUID, the local id and server id match, so the orphan
    // synced row from the half-completed migration is cleaned up
    // immediately by deleteDocument's syncedRepository.delete(id).
    expect(localRepo.delete).toHaveBeenCalledWith("doc-1");
    expect(syncedRepo.delete).toHaveBeenCalledWith("doc-1");
    expect(syncedRepo.store.has("doc-1")).toBe(false);

    // doc-1 is gone everywhere; doc-2 remains.
    expect(result.current.documents.map((d) => d.id)).toEqual(["doc-2"]);

    // Drain the mocked push so no pending promise leaks between tests.
    resolvePush();
  });

  it("resets converting and conversionErrors when the synced repository identity changes (logout)", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockRejectedValue(new Error("Snapshot push failed: 500"));
    const uploadAsset = vi.fn();

    // The explicit type annotation widens `initialProps.syncedRepository`
    // to `DocumentRepository | undefined`; without it, renderHook's
    // generic inference narrows Props to `DocumentRepository` based on
    // the concrete initial value and the later `rerender(undefined)`
    // call would be a TS error.
    const initialProps: {
      syncedRepository: DocumentRepository | undefined;
    } = { syncedRepository: syncedRepo.repo };
    const { result, rerender } = renderHook(
      (props: { syncedRepository: DocumentRepository | undefined }) =>
        useDocumentManager({
          localRepository: localRepo.repo,
          syncedRepository: props.syncedRepository,
          migrationOverrides: { uploadAsset, pushSnapshot },
        }),
      { initialProps },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });
    expect(result.current.conversionErrors.has("doc-1")).toBe(true);

    // Simulate a logout by swapping syncedRepository to undefined.
    rerender({ syncedRepository: undefined });

    await waitFor(() => expect(result.current.conversionErrors.size).toBe(0));
    expect(result.current.converting.size).toBe(0);
  });

  it("resets migration state across a logout → login cycle", async () => {
    const localRepo = makeFakeRepo("local", [
      makeLocalDocWithSnapshot("doc-1"),
    ]);
    const syncedRepo = makeFakeRepo("synced");

    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockRejectedValue(new Error("Snapshot push failed: 500"));
    const uploadAsset = vi.fn();

    const initialProps: {
      syncedRepository: DocumentRepository | undefined;
    } = { syncedRepository: syncedRepo.repo };
    const { result, rerender } = renderHook(
      (props: { syncedRepository: DocumentRepository | undefined }) =>
        useDocumentManager({
          localRepository: localRepo.repo,
          syncedRepository: props.syncedRepository,
          migrationOverrides: { uploadAsset, pushSnapshot },
        }),
      { initialProps },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Seed an error while logged in.
    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });
    expect(result.current.conversionErrors.has("doc-1")).toBe(true);

    // Logout clears state.
    rerender({ syncedRepository: undefined });
    await waitFor(() => expect(result.current.conversionErrors.size).toBe(0));

    // Login again with the same repo identity — the reset effect fires
    // on every repo change, so the state must stay clean. This is the
    // symmetric counterpart to the logout test above.
    rerender({ syncedRepository: syncedRepo.repo });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.converting.size).toBe(0);
    expect(result.current.conversionErrors.size).toBe(0);
  });

  it("convertToSynced is a no-op when no synced repository is configured", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("doc-1", "a0", "local")]);

    const { result } = renderHook(() =>
      useDocumentManager({ localRepository: localRepo.repo }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.convertToSynced("doc-1");
    });

    expect(localRepo.delete).not.toHaveBeenCalled();
    expect(result.current.documents[0].origin).toBe("local");
  });

  it("treats createDocument({origin: 'synced'}) as a no-op when no synced repository is configured", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("L1", "a0", "local")]);

    const { result } = renderHook(() =>
      useDocumentManager({ localRepository: localRepo.repo }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createDocument({ origin: "synced" });
    });

    // localRepo.save should have been called exactly zero times — L1 already
    // exists from the fixture, and the synced-origin create should not fall
    // through to local here (that fallback is only for the last-doc-delete
    // replacement path).
    expect(localRepo.save).not.toHaveBeenCalled();
    expect(result.current.documents.map((d) => d.id)).toEqual(["L1"]);
  });
});
