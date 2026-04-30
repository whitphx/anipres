import { apiClient } from "../lib/api-client";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentInput, DocumentMeta } from "./types";

// Wire shape comes from the worker route's `c.json(row, ...)`. We
// only need a structural alias here; the `DocumentMeta` shape we
// project to is the app's domain type.
interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  sort_order: string;
  created_at: number;
  updated_at: number;
}

function rowToMeta(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: "synced",
  };
}

/**
 * Documents are workspace-owned on the server. Every list/save call
 * has to name the workspace it's targeting; an `ApiDocumentRepository`
 * instance is bound to one workspace for its lifetime. App-level code
 * is responsible for resolving the user's workspace_id (via
 * `GET /api/workspaces`) and constructing the repo with it.
 *
 * Per-document operations (`get`, `delete`) take a doc id which
 * already implicitly identifies a workspace, so they don't need the
 * workspace_id at the wire layer — the server still verifies that
 * the doc lives in a workspace the requesting user owns.
 */
export class ApiDocumentRepository implements DocumentRepository {
  constructor(private readonly workspaceId: string) {}

  async list(): Promise<DocumentMeta[]> {
    const res = await apiClient.api.documents.$get({
      query: { workspace_id: this.workspaceId },
    });
    if (res.status !== 200) {
      throw new Error(`Failed to list documents: ${res.status}`);
    }
    const rows = await res.json();
    return rows.map(rowToMeta);
  }

  async get(id: string): Promise<DocumentData | undefined> {
    const res = await apiClient.api.documents[":id"].$get({ param: { id } });
    if (res.status === 404) return undefined;
    if (res.status !== 200) {
      throw new Error(`Failed to get document: ${res.status}`);
    }
    const body = await res.json();
    return {
      meta: rowToMeta(body.meta),
      snapshot: body.snapshot,
    };
  }

  /**
   * PUT /api/documents/:id — server-side upsert. The body always
   * carries workspace_id, title, and sort_order; `created_at` is sent
   * only when the caller explicitly supplies it (the local→synced
   * migration uses this to preserve the on-device creation time).
   * The server stamps `updated_at` (via trigger) and the slug (on
   * insert only) and returns the canonical row.
   *
   * The id is in the URL path; it's not duplicated in the body.
   */
  async save(input: DocumentInput): Promise<DocumentData> {
    const body: {
      workspace_id: string;
      title: string;
      sort_order: string;
      created_at?: number;
    } = {
      workspace_id: this.workspaceId,
      title: input.meta.title,
      sort_order: input.meta.sortOrder,
    };
    if (input.meta.createdAt !== undefined) {
      body.created_at = input.meta.createdAt;
    }
    const res = await apiClient.api.documents[":id"].$put({
      param: { id: input.meta.id },
      json: body,
    });
    // Server returns 200 (update) or 201 (insert); both are success.
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Failed to save document: ${res.status}`);
    }
    const row = await res.json();
    return {
      meta: rowToMeta(row),
      // Snapshot is uploaded separately (PUT /api/documents/:id/snapshot);
      // the save response only carries metadata.
      snapshot: input.snapshot,
    };
  }

  async delete(id: string): Promise<void> {
    const res = await apiClient.api.documents[":id"].$delete({
      param: { id },
    });
    if (!res.ok) {
      throw new Error(`Failed to delete document: ${res.status}`);
    }
  }
}
