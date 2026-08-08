import {
  createStore,
  get,
  set,
  del,
  entries,
  promisifyRequest,
} from "idb-keyval";
import { compareOrderKeys } from "anipres/models";
import type { TLStoreSnapshot } from "tldraw";
import type { LocalDocumentRepository } from "./repository";
import type { DocumentData, DocumentInput, DocumentMeta } from "./types";

const store = createStore("anipres-documents", "documents");

function stampLocal(meta: DocumentMeta): DocumentMeta {
  return { ...meta, source: "local" };
}

export class IdbDocumentRepository implements LocalDocumentRepository {
  async list(): Promise<DocumentMeta[]> {
    const all = await entries<string, DocumentData>(store);
    return all
      .map(([, data]) => stampLocal(data.meta))
      .sort((a, b) => compareOrderKeys(a.sortOrder, b.sortOrder));
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

  // Patterned after idb-keyval's `update` (Apache-2.0, © Jake Archibald;
  // https://github.com/jakearchibald/idb-keyval/blob/main/src/index.ts):
  // the get and the conditional put share one readwrite transaction.
  // `update` itself cannot express this operation because it
  // unconditionally writes the updater's return value, and a missing
  // document must stay missing here.
  async updateSnapshot(id: string, snapshot: TLStoreSnapshot): Promise<void> {
    await store(
      "readwrite",
      (s) =>
        new Promise<void>((resolve, reject) => {
          const request = s.get(id);
          request.onsuccess = () => {
            try {
              const existing = request.result as DocumentData | undefined;
              if (existing === undefined) {
                resolve();
                return;
              }
              s.put(
                {
                  ...existing,
                  snapshot,
                  meta: { ...existing.meta, updatedAt: Date.now() },
                },
                id,
              );
              resolve(promisifyRequest(s.transaction).then(() => undefined));
            } catch (error) {
              reject(error);
            }
          };
          request.onerror = () => reject(request.error);
        }),
    );
  }
}
