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
 * The repository owns id allocation and timestamp stamping; callers
 * supply only the user-meaningful fields:
 *
 * - `id` is optional. The local IDB repo mints a fresh UUID when
 *   omitted (or honors a caller-supplied one for stable identity-
 *   from-creation); the API repo always ignores it and the server
 *   allocates the canonical INTEGER id at INSERT time.
 * - `createdAt` is optional. It exists only as an escape hatch for
 *   the local→synced migration to preserve a doc's on-device
 *   creation time. In every other call site the repo (or the
 *   server, via column DEFAULT) stamps it.
 * - `updatedAt` is not on the draft at all — repos always stamp it
 *   themselves on create; on update, the IDB repo bumps it and the
 *   server's updated_at trigger handles it.
 *
 * `create()` always returns a `DocumentData` with the canonical id
 * and timestamps.
 */
export interface DocumentDraft {
  meta: Pick<DocumentMeta, "title" | "sortOrder" | "origin"> & {
    id?: string;
    createdAt?: number;
  };
  snapshot: TLStoreSnapshot | null;
}
