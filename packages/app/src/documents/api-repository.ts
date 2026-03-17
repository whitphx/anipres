import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta } from "./types";

interface DocumentRow {
  id: string;
  title: string;
  order: number;
  created_at: number;
  updated_at: number;
}

function rowToMeta(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    title: row.title,
    order: row.order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  async save(data: DocumentData): Promise<void> {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(data.meta.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.meta.title,
          order: data.meta.order,
          created_at: data.meta.createdAt,
          updated_at: data.meta.updatedAt,
        }),
      },
    );
    if (!res.ok) throw new Error(`Failed to save document: ${res.status}`);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to delete document: ${res.status}`);
  }
}
