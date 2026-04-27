import type { TLStoreSnapshot } from "tldraw";

export type DocumentOrigin = "local" | "synced";

export interface DocumentMeta {
  id: string;
  /**
   * Server-issued URL handle for synced docs; absent for local-only
   * docs that haven't yet been migrated to the server.
   */
  slug?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Fractional-indexing key (the `fractional-indexing` npm package).
   * Lexicographic order over these strings matches the user-facing
   * ordering of documents in the sidebar.
   */
  sortOrder: string;
  origin: DocumentOrigin;
}

export interface DocumentData {
  meta: DocumentMeta;
  snapshot: TLStoreSnapshot | null;
}

/**
 * Input shape for creating a new document. The id is optional because
 * each repository owns its own id-allocation policy:
 *
 * - The local IDB repo allocates a fresh UUID when `id` is omitted,
 *   or uses the caller-provided id when supplied (callers may want
 *   to mint the id upfront so they can reference it before the
 *   create resolves).
 * - The API (synced) repo always ignores `id`; the server allocates
 *   the canonical INTEGER id at INSERT time. Caller-supplied values
 *   are silently dropped.
 *
 * `create()` always returns a `DocumentData` with the canonical id.
 */
export interface DocumentDraft {
  meta: Omit<DocumentMeta, "id"> & { id?: string };
  snapshot: TLStoreSnapshot | null;
}
