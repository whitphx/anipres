import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINIMUM_SYNC_ANIMATION_DATA_VERSION } from "anipres-worker/animation-data-version";
import type { TLStoreSnapshot } from "tldraw";
import { putSnapshot } from "./snapshot-push";

const SNAPSHOT = {
  store: { "shape:a": { id: "shape:a" } },
  schema: {},
} as unknown as TLStoreSnapshot;

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

describe("putSnapshot", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always declares the animation-data version header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse({ ok: true }));

    await putSnapshot({
      documentId: "doc-id",
      snapshot: SNAPSHOT,
      expectedSnapshotVersion: 3,
    });

    const request = capturedRequest(vi.mocked(fetch).mock.calls[0]);
    expect(request.method).toBe("PUT");
    expect(request.url).toContain("/api/documents/doc-id/snapshot");
    expect(request.headers.get("x-anipres-animation-data-version")).toBe(
      String(MINIMUM_SYNC_ANIMATION_DATA_VERSION),
    );
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
