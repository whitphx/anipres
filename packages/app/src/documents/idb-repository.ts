import { createStore, get, set, del, entries } from "idb-keyval";
import type { DocumentRepository } from "./repository";
import type { DocumentData, DocumentInput, DocumentMeta } from "./types";

const store = createStore("anipres-documents", "documents");

function stampLocal(meta: DocumentMeta): DocumentMeta {
  return { ...meta, source: "local" };
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

  /**
   * Insert or update the row at `input.meta.id`. On insert, stamps
   * `createdAt` (honoring the optional override) and `updatedAt`. On
   * update, bumps `updatedAt` and preserves the existing `createdAt`
   * — even if a different value is in `input.meta.createdAt`, the
   * stored row's createdAt wins, since it represents the actual
   * on-device creation moment.
   */
  async save(input: DocumentInput): Promise<DocumentData> {
    const now = Date.now();
    const existing = await get<DocumentData>(input.meta.id, store);
    const data: DocumentData = {
      snapshot: input.snapshot,
      meta: {
        ...input.meta,
        createdAt: existing?.meta.createdAt ?? input.meta.createdAt ?? now,
        updatedAt: now,
      },
    };
    await set(data.meta.id, data, store);
    return { ...data, meta: stampLocal(data.meta) };
  }

  async delete(id: string): Promise<void> {
    await del(id, store);
  }
}
