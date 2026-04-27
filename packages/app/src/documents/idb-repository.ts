import { createStore, get, set, del, entries } from "idb-keyval";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentDraft, DocumentMeta } from "./types";

const store = createStore("anipres-documents", "documents");

function stampLocal(meta: DocumentMeta): DocumentMeta {
  return { ...meta, origin: "local" };
}

export class IdbDocumentRepository implements DocumentRepository {
  async list(): Promise<DocumentMeta[]> {
    const all = await entries<string, DocumentData>(store);
    return all
      .map(([, data]) => stampLocal(data.meta))
      .sort((a, b) => a.sortOrder.localeCompare(b.sortOrder));
  }

  async get(id: string): Promise<DocumentData | undefined> {
    const data = await get<DocumentData>(id, store);
    if (!data) return undefined;
    return { ...data, meta: stampLocal(data.meta) };
  }

  // Create and update collapse to the same `set()` call here — IDB
  // doesn't distinguish — but the interface keeps them separate so
  // the API repo can split POST (create) from PUT (update).
  async create(draft: DocumentDraft): Promise<DocumentData> {
    const id = draft.meta.id ?? crypto.randomUUID();
    const data: DocumentData = { ...draft, meta: { ...draft.meta, id } };
    await set(id, data, store);
    return { ...data, meta: stampLocal(data.meta) };
  }

  async update(data: DocumentData): Promise<void> {
    await set(data.meta.id, data, store);
  }

  async delete(id: string): Promise<void> {
    await del(id, store);
  }
}
