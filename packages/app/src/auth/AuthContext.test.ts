import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMe } from "./me-fetcher";

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("fetchMe", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the user on 200", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: 42 }, 200));
    const result = await fetchMe();
    expect(result).toEqual({ id: 42 });
  });

  it("returns null on 401 (logged out)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: "Not authenticated" }, 401),
    );
    const result = await fetchMe();
    expect(result).toBeNull();
  });

  // Regression guard: a 5xx must NOT be silently treated as logged
  // out. Previously the typed-RPC rollout simplified the fetcher to
  // `200 → user, anything else → null`, which masked server errors as
  // logout — SWR's `error` channel would never see them.
  it("throws on 500 instead of treating it as logged out", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: "Internal Server Error" }, 500),
    );
    await expect(fetchMe()).rejects.toThrow(/500/);
  });

  it("throws on 503 (any non-200 non-401 surface)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(fetchMe()).rejects.toThrow(/503/);
  });
});
