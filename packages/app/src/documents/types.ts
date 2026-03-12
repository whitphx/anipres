import type { TLStoreSnapshot } from "tldraw";

export interface DocumentMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  order: number;
}

export interface DocumentData {
  meta: DocumentMeta;
  snapshot: TLStoreSnapshot | null;
}
