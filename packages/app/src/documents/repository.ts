import type { DocumentData, DocumentInput, DocumentMeta } from "./types";

export interface DocumentRepository {
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentData | undefined>;
  /**
   * Save a document — insert if new, update if existing. The single
   * upsert shape is consistent across both repos: the IDB repo
   * collapses insert and update into the same `set()` call by id, and
   * the API repo's `PUT /api/documents/:id` is server-side upsert.
   *
   * The caller-supplied `id` is the canonical id everywhere — UUID v7
   * is client-allocated, see the documents.id design note in the
   * worker schema. The repo stamps timestamps; on insert it sets
   * `createdAt` (or honors the optional override) and `updatedAt`,
   * on update it bumps `updatedAt` and preserves `createdAt`.
   *
   * Returns the saved doc with all server-side stamps (slug, current
   * timestamps) populated.
   */
  save(input: DocumentInput): Promise<DocumentData>;
  delete(id: string): Promise<void>;
}
