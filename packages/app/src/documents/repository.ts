import type { DocumentData, DocumentMeta } from "./types";

export interface DocumentRepository {
  list(): Promise<DocumentMeta[]>;
  get(id: string): Promise<DocumentData | undefined>;
  save(data: DocumentData): Promise<void>;
  delete(id: string): Promise<void>;
}
