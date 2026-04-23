import type { TLStoreSnapshot } from "tldraw";

export type DocumentOrigin = "local" | "synced";

export interface DocumentMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  order: number;
  origin: DocumentOrigin;
}

export interface DocumentData {
  meta: DocumentMeta;
  snapshot: TLStoreSnapshot | null;
}
