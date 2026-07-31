import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareOrderKeys } from "anipres/models";
import { MINIMUM_SYNC_ANIMATION_DATA_VERSION } from "anipres-worker/animation-data-version";
import type { TLStoreSnapshot } from "tldraw";
import { reconcileOfflineEdits } from "./reconnect";
import { CLIENT_TOO_OLD_MESSAGE } from "./snapshot-push";

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

/** Rebuilds the outgoing request from a captured `fetch` call. */
function capturedRequest(call: unknown[]): Request {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
  if (input instanceof Request) {
    return input;
  }
  // The client uses a relative base; anchor it so Request construction
  // works under Node.
  return new Request(new URL(String(input), "http://test.local"), init);
}

function expectSnapshotPutWithVersionHeader(call: unknown[]) {
  const request = capturedRequest(call);
  expect(request.method).toBe("PUT");
  expect(request.url).toContain("/snapshot");
  expect(request.headers.get("x-anipres-animation-data-version")).toBe(
    String(MINIMUM_SYNC_ANIMATION_DATA_VERSION),
  );
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
    expect(compareOrderKeys(sentToCreate.meta.sortOrder, "a1")).toBeGreaterThan(
      0,
    );
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

// Request-level coverage: the worker's animation-data version gate
// rejects any snapshot PUT that does not declare the version header, so
// every reconnect write path must send it — response-sequence mocks
// alone would keep passing if a call site dropped the header.
describe("reconcileOfflineEdits — snapshot PUT version header", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const local = createSnapshot("local-edits");
  const baseline = createSnapshot("baseline");

  function makeRepository() {
    return {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      list: vi
        .fn()
        .mockResolvedValue([
          { id: "doc-id", title: "Foo", sortOrder: "a0", source: "synced" },
        ]),
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
      delete: vi.fn().mockResolvedValue(undefined),
    } as const;
  }

  function params(repository: ReturnType<typeof makeRepository>) {
    return {
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: local,
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    };
  }

  it("declares the version on the initial reconnect push", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reconcileOfflineEdits(params(makeRepository()));

    expect(result).toEqual({ action: "pushed" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expectSnapshotPutWithVersionHeader(vi.mocked(fetch).mock.calls[0]);
  });

  it("declares the version on BOTH pushes of a stale-version retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: baseline, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reconcileOfflineEdits(params(makeRepository()));

    expect(result).toEqual({ action: "pushed" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expectSnapshotPutWithVersionHeader(vi.mocked(fetch).mock.calls[0]);
    expectSnapshotPutWithVersionHeader(vi.mocked(fetch).mock.calls[2]);
  });

  it("declares the version on the offline-copy fork push", async () => {
    const server = createSnapshot("server-diverged");
    const repository = makeRepository();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: server, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reconcileOfflineEdits(params(repository));

    expect(result.action).toBe("forked");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expectSnapshotPutWithVersionHeader(vi.mocked(fetch).mock.calls[2]);
  });
});

describe("reconcileOfflineEdits — HTTP 426 (client too old)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const local = createSnapshot("local-edits");
  const baseline = createSnapshot("baseline");
  const clientTooOldResult = {
    action: "error",
    reason: CLIENT_TOO_OLD_MESSAGE,
    reasonCode: "client-too-old",
  };

  function makeRepository() {
    return {
      get: vi.fn().mockResolvedValue({
        meta: { id: "doc-id", title: "Foo", sortOrder: "a0" },
      }),
      list: vi
        .fn()
        .mockResolvedValue([
          { id: "doc-id", title: "Foo", sortOrder: "a0", source: "synced" },
        ]),
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
      delete: vi.fn().mockResolvedValue(undefined),
    } as const;
  }

  function params(repository: ReturnType<typeof makeRepository>) {
    return {
      documentId: "doc-id",
      localSnapshot: local,
      recovery: {
        baselineSnapshot: baseline,
        reconnectSnapshot: local,
        hasPendingOfflineChanges: true,
      },
      snapshotVersion: 3,
      repository: repository as never,
    };
  }

  it("stops at the initial push: no cache compare, no fork, no cleanup", async () => {
    const repository = makeRepository();
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(null, 426));

    const result = await reconcileOfflineEdits(params(repository));

    expect(result).toEqual(clientTooOldResult);
    // No offline-cache fetch, no retry, no fork push.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("stops at the stale-version retry: no fork", async () => {
    const repository = makeRepository();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: baseline, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse(null, 426));

    const result = await reconcileOfflineEdits(params(repository));

    expect(result).toEqual(clientTooOldResult);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("cleans up the fork placeholder when the fork push is rejected", async () => {
    const server = createSnapshot("server-diverged");
    const repository = makeRepository();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockResponse({ reason: "version-conflict", snapshotVersion: 10 }, 409),
      )
      .mockResolvedValueOnce(
        mockResponse({ snapshot: server, snapshotVersion: 10 }),
      )
      .mockResolvedValueOnce(mockResponse(null, 426));

    const result = await reconcileOfflineEdits(params(repository));

    expect(result).toEqual(clientTooOldResult);
    // The empty fork row was created and then removed — a version-gated
    // push must not leave a ghost document behind.
    expect(repository.save).toHaveBeenCalledTimes(1);
    const forkId = (
      repository.save.mock.calls[0][0] as { meta: { id: string } }
    ).meta.id;
    expect(repository.delete).toHaveBeenCalledWith(forkId);
  });
});
