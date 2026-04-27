import { describe, expect, it, vi } from "vitest";
import type { TLStoreSnapshot } from "tldraw";
import type {
  DocumentData,
  DocumentDraft,
  DocumentMeta,
  DocumentOrigin,
} from "./types";
import type { DocumentRepository } from "./repository";
import {
  convertLocalDocToSynced,
  dataUrlToFile,
  findDataUrlAssets,
  isDataUrl,
  rewriteAssetSrcs,
  uploadAssetDataUrls,
} from "./migration";

function assetRecord(id: string, src: string) {
  return {
    id,
    typeName: "asset" as const,
    type: "image",
    props: { src, w: 10, h: 10 },
    meta: {},
  };
}

function snapshotWith(records: Record<string, unknown>): TLStoreSnapshot {
  return {
    store: records,
    schema: {},
  } as unknown as TLStoreSnapshot;
}

function getAssetSrc(snapshot: TLStoreSnapshot, recordId: string): string {
  const record = (snapshot.store as Record<string, unknown>)[recordId] as {
    props: { src: string };
  };
  return record.props.src;
}

function makeLocalDoc(
  id: string,
  snapshot: TLStoreSnapshot | null = null,
): DocumentData {
  return {
    meta: {
      id,
      title: id,
      sortOrder: "a0",
      createdAt: 0,
      updatedAt: 0,
      origin: "local",
    },
    snapshot,
  };
}

function makeFakeRepo(origin: DocumentOrigin, initial: DocumentData[] = []) {
  const store = new Map<string, DocumentData>();
  for (const d of initial) store.set(d.meta.id, d);

  // For the API repo, the server allocates an INTEGER id. Tests that
  // exercise the synced path can override this by providing their own
  // create mock; the default below preserves the caller's id so
  // assertions on specific ids stay simple.
  let serverIdCounter = 1000;

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
  const create = vi.fn(async (d: DocumentDraft): Promise<DocumentData> => {
    // Synced repo allocates a server id; local repo honors any
    // caller-supplied id and falls back to a fresh UUID otherwise.
    // Mirror that policy so tests can exercise both.
    const allocatedId =
      origin === "synced"
        ? String(++serverIdCounter)
        : (d.meta.id ?? crypto.randomUUID());
    const now = Date.now();
    const stored: DocumentData = {
      ...d,
      meta: {
        ...d.meta,
        id: allocatedId,
        origin,
        createdAt: d.meta.createdAt ?? now,
        updatedAt: now,
      },
    };
    store.set(allocatedId, stored);
    return stored;
  });
  const update = vi.fn(async (d: DocumentData): Promise<void> => {
    store.set(d.meta.id, d);
  });
  const del = vi.fn(async (id: string): Promise<void> => {
    store.delete(id);
  });
  const repo: DocumentRepository = {
    list,
    get,
    create,
    update,
    delete: del,
  };
  return { repo, store, list, get, create, update, delete: del };
}

describe("isDataUrl", () => {
  it("returns true for a data URL", () => {
    expect(isDataUrl("data:image/png;base64,AAAA")).toBe(true);
  });

  it("returns false for an http URL", () => {
    expect(isDataUrl("https://example.com/x.png")).toBe(false);
  });

  it("returns false for relative paths", () => {
    expect(isDataUrl("/api/documents/doc/assets/x.png")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isDataUrl(undefined)).toBe(false);
    expect(isDataUrl(null)).toBe(false);
    expect(isDataUrl(42)).toBe(false);
  });
});

describe("dataUrlToFile", () => {
  it("decodes a base64 PNG data URL into a File with the right MIME and bytes", async () => {
    // 1x1 transparent PNG
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const file = await dataUrlToFile(
      `data:image/png;base64,${b64}`,
      "pixel.png",
    );
    expect(file.name).toBe("pixel.png");
    expect(file.type).toBe("image/png");
    const buffer = new Uint8Array(await file.arrayBuffer());
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it("decodes a URL-encoded text data URL", async () => {
    const file = await dataUrlToFile(
      "data:image/svg+xml,%3Csvg%2F%3E",
      "icon.svg",
    );
    expect(file.type).toBe("image/svg+xml");
    expect(await file.text()).toBe("<svg/>");
  });

  it("rejects on invalid input", async () => {
    await expect(dataUrlToFile("not-a-data-url", "x.bin")).rejects.toThrow();
  });

  it("rejects on a header without a comma", async () => {
    await expect(
      dataUrlToFile("data:image/png;base64", "x.bin"),
    ).rejects.toThrow();
  });

  it("returns promptly on adversarial inputs (no catastrophic backtracking)", async () => {
    // CodeQL js/redos shape on the previous regex
    // /^data:([^;,]+)((?:;[^,]*)*),(.*)$/ — strings starting with
    // "data:+" and many ";" caused exponential backtracking. The
    // platform fetch parser is C-level and immune; budget is generous
    // to absorb CI jitter.
    const adversarial = "data:+" + ";".repeat(100_000);
    const start = Date.now();
    await expect(dataUrlToFile(adversarial, "x.bin")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("findDataUrlAssets", () => {
  it("returns asset records whose src is a data URL and ignores external URLs", () => {
    const snapshot = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
      "asset:b": assetRecord("asset:b", "https://example.com/x.png"),
      "asset:c": assetRecord("asset:c", "data:image/jpeg;base64,BBBB"),
      "shape:s1": { id: "shape:s1", typeName: "shape", props: {} },
    });
    const result = findDataUrlAssets(snapshot);
    expect(result).toEqual([
      { recordId: "asset:a", dataUrl: "data:image/png;base64,AAAA" },
      { recordId: "asset:c", dataUrl: "data:image/jpeg;base64,BBBB" },
    ]);
  });

  it("returns an empty array when there are no asset records", () => {
    expect(findDataUrlAssets(snapshotWith({}))).toEqual([]);
  });
});

describe("rewriteAssetSrcs", () => {
  it("replaces asset srcs without mutating the input snapshot", () => {
    const original = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
      "asset:b": assetRecord("asset:b", "data:image/jpeg;base64,BBBB"),
    });
    const rewrites = new Map<string, string>([
      ["asset:a", "/api/documents/doc/assets/a.png"],
      ["asset:b", "/api/documents/doc/assets/b.jpg"],
    ]);
    const result = rewriteAssetSrcs(original, rewrites);

    // Input unchanged
    expect(getAssetSrc(original, "asset:a")).toBe("data:image/png;base64,AAAA");
    // Result reflects rewrites
    expect(getAssetSrc(result, "asset:a")).toBe(
      "/api/documents/doc/assets/a.png",
    );
    expect(getAssetSrc(result, "asset:b")).toBe(
      "/api/documents/doc/assets/b.jpg",
    );
  });

  it("ignores unknown ids and non-asset records", () => {
    const original = snapshotWith({
      "shape:s1": { id: "shape:s1", typeName: "shape", props: {} },
    });
    const rewrites = new Map<string, string>([
      ["asset:missing", "/new/src"],
      ["shape:s1", "/new/src"],
    ]);
    const result = rewriteAssetSrcs(original, rewrites);
    expect(result.store).toEqual(original.store);
  });

  it("returns the input snapshot when rewrites is empty", () => {
    const original = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
    });
    expect(rewriteAssetSrcs(original, new Map())).toBe(original);
  });
});

describe("uploadAssetDataUrls", () => {
  it("uploads each data-URL asset once and returns a rewritten snapshot", async () => {
    const snapshot = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
      "asset:b": assetRecord("asset:b", "data:image/jpeg;base64,BBBB"),
      "asset:external": assetRecord(
        "asset:external",
        "https://example.com/x.png",
      ),
    });
    const uploadFile = vi
      .fn<(file: File) => Promise<{ src: string }>>()
      .mockImplementation(async (file) => ({
        src: `/uploaded/${file.name}`,
      }));
    const result = await uploadAssetDataUrls(snapshot, uploadFile);

    expect(uploadFile).toHaveBeenCalledTimes(2);
    const uploaded = uploadFile.mock.calls.map((call) => call[0].name);
    expect(uploaded).toContain("asset:a");
    expect(uploaded).toContain("asset:b");
    expect(getAssetSrc(result, "asset:a")).toBe("/uploaded/asset:a");
    expect(getAssetSrc(result, "asset:external")).toBe(
      "https://example.com/x.png",
    );
  });

  it("returns the input snapshot unchanged when no data-URL assets exist", async () => {
    const snapshot = snapshotWith({
      "asset:external": assetRecord(
        "asset:external",
        "https://example.com/x.png",
      ),
    });
    const uploadFile = vi.fn();
    const result = await uploadAssetDataUrls(snapshot, uploadFile);
    expect(result).toBe(snapshot);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("convertLocalDocToSynced", () => {
  it("creates server metadata, uploads data-URL assets, pushes the snapshot, and deletes the local copy", async () => {
    const snapshot = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
    });
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", snapshot)]);
    // Pre-populate the synced repo with a doc at sortOrder "a0"; the
    // migrated doc should land strictly after it.
    const existingSynced: DocumentData = {
      meta: {
        id: "existing",
        title: "existing",
        sortOrder: "a0",
        createdAt: 0,
        updatedAt: 0,
        origin: "synced",
      },
      snapshot: null,
    };
    const syncedRepo = makeFakeRepo("synced", [existingSynced]);

    const uploadAsset = vi
      .fn<(documentId: string, file: File) => Promise<{ src: string }>>()
      .mockImplementation(async (documentId, file) => {
        void documentId;
        return { src: `/uploaded/${file.name}` };
      });
    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await convertLocalDocToSynced({
      documentId: "doc-1",
      localRepository: localRepo.repo,
      syncedRepository: syncedRepo.repo,
      uploadAsset,
      pushSnapshot,
    });

    expect(syncedRepo.create).toHaveBeenCalledTimes(1);
    // The synced repo allocates a server-side id; the migrated doc
    // does NOT keep the local "doc-1" id.
    expect(result.meta.id).not.toBe("doc-1");
    expect(result.meta.origin).toBe("synced");
    // Sort-order is computed past the existing tail.
    expect(result.meta.sortOrder > "a0").toBe(true);

    // Asset upload and snapshot push both target the new server id,
    // not the local UUID.
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    expect(uploadAsset.mock.calls[0][0]).toBe(result.meta.id);

    expect(pushSnapshot).toHaveBeenCalledTimes(1);
    expect(pushSnapshot.mock.calls[0][0]).toBe(result.meta.id);
    const pushedSnapshot = pushSnapshot.mock.calls[0][1];
    expect(getAssetSrc(pushedSnapshot, "asset:a")).toBe("/uploaded/asset:a");

    expect(localRepo.delete).toHaveBeenCalledWith("doc-1");
    expect(localRepo.store.has("doc-1")).toBe(false);
  });

  it("skips asset upload and snapshot push when the local doc has no snapshot", async () => {
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", null)]);
    const syncedRepo = makeFakeRepo("synced");

    const uploadAsset = vi.fn();
    const pushSnapshot = vi.fn();

    await convertLocalDocToSynced({
      documentId: "doc-1",
      localRepository: localRepo.repo,
      syncedRepository: syncedRepo.repo,
      uploadAsset,
      pushSnapshot,
    });

    expect(syncedRepo.create).toHaveBeenCalledTimes(1);
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(pushSnapshot).not.toHaveBeenCalled();
    expect(localRepo.delete).toHaveBeenCalledWith("doc-1");
  });

  it("propagates the error and leaves the local copy intact when an asset upload fails", async () => {
    const snapshot = snapshotWith({
      "asset:a": assetRecord("asset:a", "data:image/png;base64,AAAA"),
      "asset:b": assetRecord("asset:b", "data:image/png;base64,BBBB"),
    });
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", snapshot)]);
    const syncedRepo = makeFakeRepo("synced");
    const uploadAsset = vi
      .fn<(documentId: string, file: File) => Promise<{ src: string }>>()
      .mockResolvedValueOnce({ src: "/uploaded/first" })
      .mockRejectedValueOnce(new Error("Asset upload failed: 413"));
    const pushSnapshot = vi
      .fn<(documentId: string, snapshot: TLStoreSnapshot) => Promise<void>>()
      .mockResolvedValue(undefined);

    await expect(
      convertLocalDocToSynced({
        documentId: "doc-1",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        uploadAsset,
        pushSnapshot,
      }),
    ).rejects.toThrow(/413/);

    expect(pushSnapshot).not.toHaveBeenCalled();
    expect(localRepo.delete).not.toHaveBeenCalled();
    expect(localRepo.store.has("doc-1")).toBe(true);
  });

  it("throws and leaves the local copy intact when the snapshot push fails", async () => {
    const snapshot = snapshotWith({});
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", snapshot)]);
    const syncedRepo = makeFakeRepo("synced");
    const uploadAsset = vi.fn();
    const pushSnapshot = vi
      .fn()
      .mockRejectedValue(new Error("Snapshot push failed: 500"));

    await expect(
      convertLocalDocToSynced({
        documentId: "doc-1",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        uploadAsset,
        pushSnapshot,
      }),
    ).rejects.toThrow("Snapshot push failed");

    expect(localRepo.delete).not.toHaveBeenCalled();
    expect(localRepo.store.has("doc-1")).toBe(true);
  });

  it("throws when the local document does not exist", async () => {
    const localRepo = makeFakeRepo("local");
    const syncedRepo = makeFakeRepo("synced");
    await expect(
      convertLocalDocToSynced({
        documentId: "missing",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    ).rejects.toThrow(/not found/);
    expect(syncedRepo.create).not.toHaveBeenCalled();
  });

  it("throws immediately without touching the repos when the abortSignal is already aborted", async () => {
    const snapshot = snapshotWith({});
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", snapshot)]);
    const syncedRepo = makeFakeRepo("synced");
    const uploadAsset = vi.fn();
    const pushSnapshot = vi.fn();

    const controller = new AbortController();
    controller.abort();

    await expect(
      convertLocalDocToSynced({
        documentId: "doc-1",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        uploadAsset,
        pushSnapshot,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(localRepo.get).not.toHaveBeenCalled();
    expect(syncedRepo.create).not.toHaveBeenCalled();
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(pushSnapshot).not.toHaveBeenCalled();
    expect(localRepo.delete).not.toHaveBeenCalled();
  });

  it("aborts mid-migration when the abortSignal fires after the synced create", async () => {
    const snapshot = snapshotWith({});
    const localRepo = makeFakeRepo("local", [makeLocalDoc("doc-1", snapshot)]);
    const syncedRepo = makeFakeRepo("synced");

    const controller = new AbortController();
    // Abort mid-migration, right after syncedRepository.create runs.
    syncedRepo.repo.create = vi.fn(async (d: DocumentDraft) => {
      const now = Date.now();
      const allocated: DocumentData = {
        ...d,
        meta: {
          ...d.meta,
          id: "server-1",
          origin: "synced",
          createdAt: d.meta.createdAt ?? now,
          updatedAt: now,
        },
      };
      syncedRepo.store.set("server-1", allocated);
      controller.abort();
      return allocated;
    });

    const pushSnapshot = vi.fn();

    await expect(
      convertLocalDocToSynced({
        documentId: "doc-1",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
        uploadAsset: vi.fn(),
        pushSnapshot,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();

    // Server doc was created before the abort; the later snapshot
    // push was skipped and the local copy was not deleted.
    expect(syncedRepo.repo.create).toHaveBeenCalledTimes(1);
    expect(pushSnapshot).not.toHaveBeenCalled();
    expect(localRepo.delete).not.toHaveBeenCalled();
  });

  it("throws when the document is already synced", async () => {
    const syncedDoc: DocumentData = {
      ...makeLocalDoc("doc-1"),
      meta: { ...makeLocalDoc("doc-1").meta, origin: "synced" },
    };
    const localRepo = makeFakeRepo("local");
    // Force the local repo's get to return a synced-origin doc — the repo
    // normally stamps "local", so this mimics a corrupted state to verify
    // the defensive guard.
    localRepo.repo.get = vi.fn().mockResolvedValue(syncedDoc);
    const syncedRepo = makeFakeRepo("synced");
    await expect(
      convertLocalDocToSynced({
        documentId: "doc-1",
        localRepository: localRepo.repo,
        syncedRepository: syncedRepo.repo,
      }),
    ).rejects.toThrow(/not a local document/);
    expect(syncedRepo.create).not.toHaveBeenCalled();
  });
});
