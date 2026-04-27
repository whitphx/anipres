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
 * Input shape for creating a new document.
 *
 * `id` is required: every doc has its UUID v7 minted client-side at
 * the moment of creation. The same id flows through both the IDB
 * write and (later, on migration) the POST /api/documents call,
 * unchanged. See the documents.id design note in the worker schema
 * for why the id is client-allocated.
 *
 * The repository owns timestamp stamping; callers supply only the
 * user-meaningful fields plus the id:
 *
 * - `createdAt` is optional. It exists only as an escape hatch for
 *   the local→synced migration to preserve a doc's on-device
 *   creation time. In every other call site the repo (or the
 *   server, via column DEFAULT) stamps it.
 * - `updatedAt` is not on the draft at all — repos always stamp it
 *   themselves on create; on update, the IDB repo bumps it and the
 *   server's updated_at trigger handles it.
 */
export interface DocumentDraft {
  meta: Pick<DocumentMeta, "id" | "title" | "sortOrder" | "origin"> & {
    createdAt?: number;
  };
  snapshot: TLStoreSnapshot | null;
}
