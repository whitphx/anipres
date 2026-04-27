import type { DocumentData, DocumentDraft, DocumentMeta } from "./types";

export interface DocumentRepository {
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentData | undefined>;
  /**
   * Create a new document. The input `id` is optional: the local IDB
   * repo allocates a UUID when missing (or honors a caller-supplied
   * one); the API (synced) repo always ignores it and lets the server
   * allocate the canonical id+slug at INSERT time.
   *
   * Always returns the saved doc with the canonical id — callers must
   * use the returned `meta.id` for any subsequent operations.
   */
  create(draft: DocumentDraft): Promise<DocumentData>;
  update(data: DocumentData): Promise<void>;
  delete(id: string): Promise<void>;
}
