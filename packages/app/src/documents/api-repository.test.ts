import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiDocumentRepository } from "./api-repository";
import type { DocumentData } from "./types";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("ApiDocumentRepository", () => {
  let repo: ApiDocumentRepository;
  const TEST_WORKSPACE_ID = "5";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    repo = new ApiDocumentRepository(TEST_WORKSPACE_ID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list maps server rows to DocumentMeta and preserves slug", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        {
          id: "42",
          slug: "hello-world",
          title: "Hello",
          sort_order: "a0",
          created_at: 1,
          updated_at: 2,
        },
      ]),
    );

    const list = await repo.list();

    expect(list).toEqual([
      {
        id: "42",
        slug: "hello-world",
        title: "Hello",
        sortOrder: "a0",
        createdAt: 1,
        updatedAt: 2,
        source: "synced",
      },
    ]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      `/api/documents?workspace_id=${TEST_WORKSPACE_ID}`,
    );
  });

  it("get returns the document shape with slug propagated", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        meta: {
          id: "42",
          slug: "hello-world",
          title: "Hello",
          sort_order: "a0",
          created_at: 1,
          updated_at: 2,
        },
        snapshot: null,
      }),
    );

    const result = await repo.get("42");

    expect(result?.meta.slug).toBe("hello-world");
    expect(result?.meta.sortOrder).toBe("a0");
    expect(result?.snapshot).toBeNull();
  });

  it("get returns undefined on 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(null, 404));
    expect(await repo.get("missing")).toBeUndefined();
  });

  it("create POSTs the client-supplied id and returns server-stamped fields", async () => {
    const docId = "0190e7c0-9c52-7000-9d4f-1a2b3c4d5e6f";
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: docId,
        slug: "server-slug",
        title: "Title",
        sort_order: "a0",
        created_at: 10,
        updated_at: 20,
      }),
    );

    const result = await repo.save({
      meta: {
        id: docId,
        title: "Title",
        sortOrder: "a0",
        createdAt: 10,
        source: "synced",
      },
      snapshot: null,
    });

    // The id is the same one the caller minted; slug, created_at,
    // and updated_at come from the server response.
    expect(result.meta.id).toBe(docId);
    expect(result.meta.slug).toBe("server-slug");
    expect(result.meta.sortOrder).toBe("a0");
    expect(result.meta.updatedAt).toBe(20);

    // PUT goes to /api/documents/:id (id in URL, not body). The body
    // sends:
    //   - workspace_id: from the repo's binding
    //   - title, sort_order: from the input
    //   - created_at: only when the caller set it (migration use case)
    // updated_at and slug never appear — the server stamps both.
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`/api/documents/${docId}`);
    expect(init?.method).toBe("PUT");
    const sent = JSON.parse((init?.body as string) ?? "{}");
    expect(sent).toEqual({
      workspace_id: TEST_WORKSPACE_ID,
      title: "Title",
      sort_order: "a0",
      created_at: 10,
    });
    expect(sent).not.toHaveProperty("id");
    expect(sent).not.toHaveProperty("slug");
    expect(sent).not.toHaveProperty("updated_at");
  });

  it("save omits created_at when the caller doesn't supply one", async () => {
    const docId = "0190e7c0-9c52-7000-9d4f-1a2b3c4d5e6f";
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: docId,
        slug: "fresh-doc",
        title: "Fresh",
        sort_order: "a0",
        created_at: 50,
        updated_at: 50,
      }),
    );

    await repo.save({
      meta: {
        id: docId,
        title: "Fresh",
        sortOrder: "a0",
        source: "synced",
      },
      snapshot: null,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const sent = JSON.parse((init?.body as string) ?? "{}");
    expect(sent).toEqual({
      workspace_id: TEST_WORKSPACE_ID,
      title: "Fresh",
      sort_order: "a0",
    });
    expect(sent).not.toHaveProperty("created_at");
  });

  it("save accepts a full DocumentData (re-save / update path)", async () => {
    const docId = "0190e7c0-9c52-7000-9d4f-1a2b3c4d5e6f";
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        id: docId,
        slug: "doc-slug",
        title: "Renamed",
        sort_order: "a1",
        created_at: 1,
        updated_at: 999,
      }),
    );

    // Pass a full DocumentData (with all timestamps and slug). The
    // repo only forwards the meaningful fields to the wire; extras
    // are dropped. DocumentData is structurally a superset of
    // DocumentInput, so the call is valid; the local-variable typing
    // hop avoids TS's excess-property check on object literals.
    const data: DocumentData = {
      meta: {
        id: docId,
        slug: "ignored",
        title: "Renamed",
        sortOrder: "a1",
        createdAt: 1,
        updatedAt: 99,
        source: "synced",
      },
      snapshot: null,
    };
    await repo.save(data);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(`/api/documents/${docId}`);
    expect(init?.method).toBe("PUT");
    const sent = JSON.parse((init?.body as string) ?? "{}");
    // The wire body has no updated_at (server's trigger handles it),
    // no slug (server-allocated on insert; ignored on update), and no
    // id (it's in the URL). created_at is forwarded because the
    // caller's input had it set.
    expect(sent).toEqual({
      workspace_id: TEST_WORKSPACE_ID,
      title: "Renamed",
      sort_order: "a1",
      created_at: 1,
    });
    expect(sent).not.toHaveProperty("updated_at");
    expect(sent).not.toHaveProperty("slug");
    expect(sent).not.toHaveProperty("id");
  });

  it("delete sends DELETE to /api/documents/:id", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));
    await repo.delete("42");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/documents/42");
    expect(init?.method).toBe("DELETE");
  });

  it("cancelInitialization sends DELETE to /api/documents/:id/initialization", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));
    await repo.cancelInitialization("42");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/documents/42/initialization");
    expect(init?.method).toBe("DELETE");
  });

  it("cancelInitialization throws on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(null, 409));
    await expect(repo.cancelInitialization("42")).rejects.toThrow(
      "Failed to cancel document initialization: 409",
    );
  });
});
