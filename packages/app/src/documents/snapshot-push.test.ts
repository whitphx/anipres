import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TLStoreSnapshot } from "tldraw";
import { putSnapshot } from "./snapshot-push";
import {
  capturedRequest,
  expectSnapshotPutRequest,
  mockResponse,
} from "./test-helpers";

const SNAPSHOT = {
  store: { "shape:a": { id: "shape:a" } },
  schema: {},
} as unknown as TLStoreSnapshot;

describe("putSnapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the version header WITHOUT displacing the client's computed headers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    await putSnapshot({
      documentId: "doc-id",
      snapshot: SNAPSHOT,
      expectedSnapshotVersion: 3,
    });

    const request = capturedRequest(vi.mocked(fetch).mock.calls[0]);
    expect(request.url).toContain("/api/documents/doc-id/snapshot");
    // Asserts content-type and client-id too: routing the version
    // header through `init.headers` would replace hono's computed
    // headers and break the worker's json validation.
    expectSnapshotPutRequest(vi.mocked(fetch).mock.calls[0]);
  });

  it("forwards the abort signal (migration timeout/abort composition)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ ok: true }));
    const controller = new AbortController();

    await putSnapshot({
      documentId: "doc-id",
      snapshot: SNAPSHOT,
      expectedSnapshotVersion: 0,
      signal: controller.signal,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    expect(init?.signal).toBe(controller.signal);
  });

  it("maps 2xx to success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ ok: true }));
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "success" });
  });

  it("maps 409 to conflict with the parsed body reason", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ reason: "active-session" }, 409),
    );
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({
      outcome: "conflict",
      status: 409,
      reason: "active-session",
    });
  });

  it("maps 409 with an unreadable body to conflict with a null reason", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "conflict", status: 409, reason: null });
  });

  it("maps 426 to client-too-old", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(
        { error: "Animation data upgrade required", reason: "client-too-old" },
        426,
      ),
    );
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "client-too-old", status: 426 });
  });

  it("maps a 426 without a reason to client-too-old", async () => {
    // A gate response from before the field existed.
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({ error: "Animation data upgrade required" }, 426),
    );
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "client-too-old", status: 426 });
  });

  it("maps the reverse direction to server-too-old", async () => {
    // Reporting this as a stale bundle would tell the user to reload
    // into the very bundle the worker just rejected.
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(
        {
          error: "Server animation data upgrade required",
          reason: "server-too-old",
        },
        426,
      ),
    );
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "server-too-old", status: 426 });
  });

  it("maps any other error status to failed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(null, 500));
    await expect(
      putSnapshot({
        documentId: "doc-id",
        snapshot: SNAPSHOT,
        expectedSnapshotVersion: 1,
      }),
    ).resolves.toEqual({ outcome: "failed", status: 500 });
  });
});
