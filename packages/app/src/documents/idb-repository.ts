import { createStore, get, set, del, entries } from "idb-keyval";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentMeta } from "./types";

const store = createStore("anipres-documents", "documents");

function stampLocal(meta: DocumentMeta): DocumentMeta {
  return { ...meta, origin: "local" };
}

export class IdbDocumentRepository implements DocumentRepository {
  async list(): Promise<DocumentMeta[]> {
    const all = await entries<string, DocumentData>(store);
    return all
      .map(([, data]) => stampLocal(data.meta))
      .sort((a, b) => a.order - b.order);
  }

  async get(id: string): Promise<DocumentData | undefined> {
    const data = await get<DocumentData>(id, store);
    if (!data) return undefined;
    return { ...data, meta: stampLocal(data.meta) };
  }

  async save(data: DocumentData): Promise<void> {
    await set(data.meta.id, data, store);
  }

  async delete(id: string): Promise<void> {
    await del(id, store);
  }
}
