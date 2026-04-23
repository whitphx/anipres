// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDocumentManager } from "./useDocumentManager";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta, DocumentOrigin } from "./types";

function makeDoc(
  id: string,
  order: number,
  origin: DocumentOrigin,
  title = id,
): DocumentData {
  return {
    meta: { id, title, order, origin, createdAt: 0, updatedAt: 0 },
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
        .sort((a, b) => a.order - b.order),
  );
  const get = vi.fn(async (id: string): Promise<DocumentData | undefined> => {
    const d = store.get(id);
    return d ? { ...d, meta: { ...d.meta, origin } } : undefined;
  });
  const save = vi.fn(async (d: DocumentData): Promise<void> => {
    store.set(d.meta.id, d);
  });
  const del = vi.fn(async (id: string): Promise<void> => {
    store.delete(id);
  });

  const repo: DocumentRepository = { list, get, save, delete: del };
  return { repo, store, list, get, save, delete: del };
}

describe("useDocumentManager", () => {
  beforeEach(() => {
    // The hook logs errors intentionally on synced failure paths. Silence
    // them in tests to keep output readable; individual assertions below
    // verify that the log fires when expected via vi.mocked(console.error).
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges synced and local documents on initial load with synced first", async () => {
    const localRepo = makeFakeRepo("local", [
      makeDoc("L1", 1, "local"),
      makeDoc("L2", 2, "local"),
    ]);
    const syncedRepo = makeFakeRepo("synced", [
      makeDoc("S1", 1, "synced"),
      makeDoc("S2", 2, "synced"),
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
    const localRepo = makeFakeRepo("local", [makeDoc("L1", 1, "local")]);
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
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", 1, "synced")]);

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
    const localRepo = makeFakeRepo("local", [makeDoc("L1", 1, "local")]);
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", 1, "synced")]);

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
    syncedRepo.store.set("S2", makeDoc("S2", 2, "synced"));

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
    const syncedRepo = makeFakeRepo("synced", [makeDoc("S1", 1, "synced")]);

    const { result } = renderHook(() =>
      useDocumentManager({
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toHaveLength(1);

    // Synced save fails — the replacement should still land, but as local.
    syncedRepo.repo.save = vi.fn().mockRejectedValue(new Error("server down"));

    await act(async () => {
      await result.current.deleteDocument("S1");
    });

    expect(localRepo.save).toHaveBeenCalledTimes(1);
    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0].origin).toBe("local");
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it("treats createDocument({origin: 'synced'}) as a no-op when no synced repository is configured", async () => {
    const localRepo = makeFakeRepo("local", [makeDoc("L1", 1, "local")]);

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
