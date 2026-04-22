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
        meta: { id: "doc-id", title: "Foo", order: 1 },
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
        meta: { id: "doc-id", title: "Foo", order: 1 },
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
        meta: { id: "doc-id", title: "Foo", order: 1 },
      }),
      save: vi.fn().mockResolvedValue(undefined),
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

    expect(result).toMatchObject({ action: "forked" });
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("retries a stale-revision push without forking when the server still matches the baseline", async () => {
    const local = createSnapshot("local");
    const baseline = createSnapshot("baseline");

    const repository = {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", order: 1 },
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
