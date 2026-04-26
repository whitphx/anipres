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
