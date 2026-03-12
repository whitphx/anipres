import { createStore, get, set, del, entries } from "idb-keyval";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta } from "./types";

const store = createStore("anipres-documents", "documents");

export class IdbDocumentRepository implements DocumentRepository {
  async list(): Promise<DocumentMeta[]> {
    const all = await entries<string, DocumentData>(store);
    return all.map(([, data]) => data.meta).sort((a, b) => a.order - b.order);
  }

  async get(id: string): Promise<DocumentData | undefined> {
    return get<DocumentData>(id, store);
  }

  async save(data: DocumentData): Promise<void> {
    await set(data.meta.id, data, store);
  }

  async delete(id: string): Promise<void> {
    await del(id, store);
  }
}
