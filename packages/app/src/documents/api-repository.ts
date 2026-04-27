import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentDraft, DocumentMeta } from "./types";

// Document ids are client-allocated UUID v7 strings (see
// `packages/worker/migrations/0001_initial_schema.sql` design note).
// The wire shape mirrors the D1 row directly — no per-field coercion
// needed.
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
    origin: "synced",
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
    const res = await fetch(
      `/api/documents?workspace_id=${encodeURIComponent(this.workspaceId)}`,
    );
    if (!res.ok) throw new Error(`Failed to list documents: ${res.status}`);
    const rows: DocumentRow[] = await res.json();
    return rows.map(rowToMeta);
  }

  async get(id: string): Promise<DocumentData | undefined> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Failed to get document: ${res.status}`);
    const body: { meta: DocumentRow; snapshot: null } = await res.json();
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
  async save(draft: DocumentDraft): Promise<DocumentData> {
    const body: {
      workspace_id: string;
      title: string;
      sort_order: string;
      created_at?: number;
    } = {
      workspace_id: this.workspaceId,
      title: draft.meta.title,
      sort_order: draft.meta.sortOrder,
    };
    if (draft.meta.createdAt !== undefined) {
      body.created_at = draft.meta.createdAt;
    }
    const res = await fetch(
      `/api/documents/${encodeURIComponent(draft.meta.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to save document: ${res.status}`);
    }
    const row: DocumentRow = await res.json();
    return {
      meta: rowToMeta(row),
      // Snapshot is uploaded separately (PUT /api/documents/:id/snapshot);
      // the save response only carries metadata.
      snapshot: draft.snapshot,
    };
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to delete document: ${res.status}`);
  }
}
