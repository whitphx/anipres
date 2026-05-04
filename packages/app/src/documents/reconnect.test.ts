import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TLStoreSnapshot } from "tldraw";
import { reconcileOfflineEdits } from "./reconnect";

function createSnapshot(id: string): TLStoreSnapshot {
  return {
    store: {
      [id]: { id },
    },
    schema: {},
  } as unknown as TLStoreSnapshot;
}

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("reconcileOfflineEdits", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the push-or-fork network round-trips when the local snapshot matches the baseline", async () => {
    const snapshot = createSnapshot("doc");
    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      save: vi.fn(),
    } as const;

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: snapshot,
      recovery: {
        baselineSnapshot: snapshot,
        reconnectSnapshot: snapshot,
        hasPendingOfflineChanges: false,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    expect(repository.get).toHaveBeenCalledWith("doc-id");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "noop" });
  });

  it("returns an error when the server document was deleted remotely while offline edits are pending", async () => {
    const localSnapshot = createSnapshot("local");
    const repository = {
      get: vi.fn().mockResolvedValue(null),
    } as const;

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot,
      recovery: {
        baselineSnapshot: createSnapshot("baseline"),
        reconnectSnapshot: createSnapshot("reconnect"),
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    expect(repository.get).toHaveBeenCalledWith("doc-id");
    expect(result).toEqual({
      action: "error",
      reason: "Document no longer exists on server",
      reasonCode: "other",
    });
  });

  it("returns an error when a remotely-deleted document has an unchanged local snapshot", async () => {
    const snapshot = createSnapshot("doc");
    const repository = {
      get: vi.fn().mockResolvedValue(null),
    } as const;

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: snapshot,
      recovery: {
        baselineSnapshot: snapshot,
        reconnectSnapshot: snapshot,
        hasPendingOfflineChanges: false,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    expect(repository.get).toHaveBeenCalledWith("doc-id");
    expect(result).toEqual({
      action: "error",
      reason: "Document no longer exists on server",
      reasonCode: "other",
    });
  });

  it("returns noop when no pending offline changes exist and the server has diverged", async () => {
    const local = createSnapshot("local");
    const baseline = createSnapshot("baseline");
    const server = createSnapshot("server-diverged");

    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      save: vi.fn(),
    } as const;

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: server, snapshotVersion: 10 }),
      );

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: baseline,
        hasPendingOfflineChanges: false,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    expect(result).toEqual({ action: "noop" });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("forks when pending offline changes exist and the server has diverged", async () => {
    const local = createSnapshot("local-edits");
    const baseline = createSnapshot("baseline");
    const server = createSnapshot("server-diverged");

    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      list: vi
        .fn()
        .mockResolvedValue([
          { id: "doc-id", title: "Foo", sortOrder: "a0", source: "synced" },
        ]),
      // The fork flow mints its own UUID v7 client-side, then calls
      // save(). The fake repo echoes the supplied input so the
      // returned row carries that same id.
      save: vi.fn().mockImplementation(async (data) => ({
        meta: {
          ...data.meta,
          slug: "fork-slug",
          createdAt: 0,
          updatedAt: 0,
          source: "synced",
        },
        snapshot: null,
      })),
      delete: vi.fn(),
    } as const;

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: server, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: local,
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    // The fork id is whatever uuidv7() produced — assert the shape
    // (returned id is a UUID and matches what was passed to save()).
    expect(result.action).toBe("forked");
    if (result.action === "forked") {
      expect(result.forkedDocumentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      const sentInput = repository.save.mock.calls[0][0] as {
        meta: { id: string };
      };
      expect(sentInput.meta.id).toBe(result.forkedDocumentId);
    }
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("places the fork past the synced list's tail, not just past the original key", async () => {
    // The original sits at "a0"; another doc already sits at "a1".
    // A naive `generateKeyBetween(originalKey, null)` would compute
    // "a1" — colliding with the existing neighbor. The fork must land
    // past the tail instead.
    const local = createSnapshot("local-edits");
    const baseline = createSnapshot("baseline");
    const server = createSnapshot("server-diverged");

    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      list: vi.fn().mockResolvedValue([
        { id: "doc-id", title: "Foo", sortOrder: "a0", source: "synced" },
        {
          id: "neighbor",
          title: "Neighbor",
          sortOrder: "a1",
          source: "synced",
        },
      ]),
      save: vi.fn().mockImplementation(async (data) => ({
        meta: {
          ...data.meta,
          id: "fork-server-id",
          slug: "fork-slug",
          createdAt: 0,
          updatedAt: 0,
          source: "synced",
        },
        snapshot: null,
      })),
      delete: vi.fn(),
    } as const;

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: server, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: local,
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    const sentToCreate = repository.save.mock.calls[0][0] as {
      meta: { sortOrder: string };
    };
    expect(sentToCreate.meta.sortOrder > "a1").toBe(true);
  });

  it("retries a stale-revision push without forking when the server still matches the baseline", async () => {
    const local = createSnapshot("local");
    const baseline = createSnapshot("baseline");

    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      save: vi.fn(),
    } as const;

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: baseline, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reconcileOfflineEdits({
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: local,
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    });

    expect(result).toEqual({ action: "pushed" });
    expect(repository.save).not.toHaveBeenCalled();
  });
});
