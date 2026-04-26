import type { DocumentData, DocumentMeta } from "./types";

export interface DocumentRepository {
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentData | undefined>;
  /**
   * Create a new document. Each repository owns its own id-allocation
   * policy:
   *
   * - The local IDB repo uses the caller-provided `data.meta.id`
   *   verbatim (callers generate a UUID up front so a fresh local
   *   doc has a stable identity even before any sync).
   * - The API (synced) repo ignores `data.meta.id` and the slug;
   *   the server allocates both at INSERT time and the returned
   *   doc carries the canonical id+slug.
   *
   * Always returns the saved doc — callers must use its `meta.id`
   * for any subsequent operations rather than the value they
   * passed in.
   */
  create(data: DocumentData): Promise<DocumentData>;
  update(data: DocumentData): Promise<void>;
  delete(id: string): Promise<void>;
}
