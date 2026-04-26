import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta } from "./types";

// Server serializes documents.id as a string (decimal-of-INTEGER) so
// the client can keep an opaque-string id type without worrying about
// JSON number precision.
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

export class ApiDocumentRepository implements DocumentRepository {
  async list(): Promise<DocumentMeta[]> {
    const res = await fetch("/api/documents");
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
   * POST /api/documents — server allocates id and slug. Caller's
   * `data.meta.id` is ignored; the returned doc carries the
   * canonical id (a stringified INTEGER from the server).
   */
  async create(data: DocumentData): Promise<DocumentData> {
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: data.meta.title,
        sort_order: data.meta.sortOrder,
        created_at: data.meta.createdAt,
        updated_at: data.meta.updatedAt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create document: ${res.status}`);
    }
    const row: DocumentRow = await res.json();
    return {
      meta: rowToMeta(row),
      // Snapshot is uploaded separately (PUT /api/documents/:id/snapshot);
      // the create response only carries metadata.
      snapshot: data.snapshot,
    };
  }

  async update(data: DocumentData): Promise<void> {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(data.meta.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.meta.title,
          sort_order: data.meta.sortOrder,
          updated_at: data.meta.updatedAt,
        }),
      },
    );
    if (!res.ok) throw new Error(`Failed to update document: ${res.status}`);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to delete document: ${res.status}`);
  }
}
