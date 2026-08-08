import type { TLStoreSnapshot } from "tldraw";
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

export interface LocalDocumentRepository extends DocumentRepository {
  /**
   * Replace an existing document's snapshot, bumping `updatedAt` and
   * leaving the rest of its meta untouched; a no-op when the document
   * no longer exists (it may have been deleted while an editor for it
   * was still mounted).
   *
   * Must be atomic — read and write in one storage transaction. The
   * editor-teardown flush depends on this: IndexedDB starts a
   * transaction only after every earlier-created readwrite transaction
   * with overlapping scope commits, and every call funnels through
   * idb-keyval's single cached connection promise so transactions are
   * created in call order. Together those guarantee that reads issued
   * after teardown (e.g. by a remounted document manager) observe the
   * flushed snapshot. A get-then-save pair has no such guarantee — a
   * read can land between the two.
   */
  updateSnapshot(id: string, snapshot: TLStoreSnapshot): Promise<void>;
}
