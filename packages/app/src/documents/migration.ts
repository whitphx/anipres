import type { TLStoreSnapshot } from "tldraw";
import { apiClient } from "../lib/api-client";
import type { DocumentRepository } from "./repository";
import { nextTailSortOrder } from "./sort-order";

export function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Parse a `data:` URL into a File. Delegates to the platform's fetch,
 * which implements the WHATWG data-URL processor — handles base64 and
 * url-encoded payloads, rejects malformed inputs, and has no JS-level
 * regex that could backtrack on attacker-shaped payloads.
 */
export async function dataUrlToFile(
  dataUrl: string,
  filename: string,
): Promise<File> {
  // Defensive early reject. fetch() would also reject a non-data URL by
  // attempting (and failing) the network request, but that produces
  // confusing errors and burns a request slot in node fetch.
  if (!dataUrl.startsWith("data:")) {
    throw new Error("Invalid data URL");
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type });
}

function isAssetRecord(
  record: unknown,
): record is { typeName: "asset"; props: { src?: unknown } } {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { typeName?: unknown }).typeName === "asset"
  );
}

export interface DataUrlAsset {
  recordId: string;
  dataUrl: string;
}

export function findDataUrlAssets(snapshot: TLStoreSnapshot): DataUrlAsset[] {
  const results: DataUrlAsset[] = [];
  for (const [id, record] of Object.entries(snapshot.store)) {
    if (!isAssetRecord(record)) continue;
    const src = record.props.src;
    if (!isDataUrl(src)) continue;
    results.push({ recordId: id, dataUrl: src });
  }
  return results;
}

/**
 * Returns a new snapshot where each asset record listed in `rewrites` has
 * its `props.src` replaced with the provided URL. The input snapshot is
 * not mutated.
 */
export function rewriteAssetSrcs(
  snapshot: TLStoreSnapshot,
  rewrites: Map<string, string>,
): TLStoreSnapshot {
  if (rewrites.size === 0) return snapshot;
  // Work against a string-keyed view of the store; tldraw types it as a
  // mapped type over branded record ids which rejects generic string
  // indexing, but structurally the store is just a string-keyed record.
  const newStore: Record<string, unknown> = { ...snapshot.store };
  for (const [id, newSrc] of rewrites) {
    const record = newStore[id];
    if (!isAssetRecord(record)) continue;
    newStore[id] = {
      ...record,
      props: { ...record.props, src: newSrc },
    };
  }
  return { ...snapshot, store: newStore as typeof snapshot.store };
}

// Cap on simultaneous in-flight asset uploads during a migration —
// leaves headroom under the browser's per-host parallel-connection
// limit for unrelated requests (the doc-list query, the snapshot
// push, etc.) while still pipelining enough to feel fast on a doc
// with many embedded images.
const ASSET_UPLOAD_CONCURRENCY = 4;

/**
 * Run `fn` over each input with at most `limit` concurrent calls. Keeps
 * the pool full: as one call resolves, the next item is dispatched
 * (vs. batching, which would wait for the slowest in each batch
 * before starting the next group).
 *
 * Results are returned in input order. On the first rejection the
 * outer promise rejects; in-flight calls are not actively cancelled
 * (the pool will not start any further items, but already-running
 * fetches must finish or be aborted via a separate signal).
 */
async function pooledMap<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Scan a snapshot for inline `data:` URL assets, upload each via the
 * injected `uploadFile` callback, and return a new snapshot with the
 * asset srcs rewritten to the uploaded URLs. Snapshots with no data-URL
 * assets are returned unchanged.
 *
 * Uploads run with bounded concurrency (`ASSET_UPLOAD_CONCURRENCY`).
 * On partial failure some assets may still reach R2 even though the
 * outer promise rejects; the worker's asset GC reconciles orphans
 * against the live snapshot and cleans them up.
 */
export async function uploadAssetDataUrls(
  snapshot: TLStoreSnapshot,
  uploadFile: (file: File) => Promise<{ src: string }>,
): Promise<TLStoreSnapshot> {
  const assets = findDataUrlAssets(snapshot);
  if (assets.length === 0) return snapshot;

  // The File constructor requires a non-empty name, but the server
  // derives the final asset key's extension from the validated MIME
  // type and ignores the upload filename. Passing the record id
  // is enough.
  const entries = await pooledMap(
    assets,
    ASSET_UPLOAD_CONCURRENCY,
    async (asset) => {
      const file = await dataUrlToFile(asset.dataUrl, asset.recordId);
      const { src } = await uploadFile(file);
      return [asset.recordId, src] as const;
    },
  );
  return rewriteAssetSrcs(snapshot, new Map(entries));
}

// Migration HTTP calls can stall on a dead connection without this;
// the rest of the app hits websocket endpoints where RTT limits are
// enforced differently. Generous enough for a max-sized asset
// upload on a slow connection but short enough to surface as a
// visible failure rather than an indefinite spinner.
const MIGRATION_FETCH_TIMEOUT_MS = 60_000;

// Internal-only signatures use `AbortSignal | undefined` rather than
// `?: AbortSignal` because every internal caller passes the parameter
// explicitly (often from a forwarded `abortSignal`). The optional `?`
// would invite a "looks safe to omit" reading at the call site that
// doesn't reflect actual usage. The public
// `ConvertLocalDocToSyncedParams` keeps `?` for consumer ergonomics.
function composeWithTimeout(userSignal: AbortSignal | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(MIGRATION_FETCH_TIMEOUT_MS);
  return userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
}

async function defaultUploadAsset(
  documentId: string,
  file: File,
  abortSignal: AbortSignal | undefined,
): Promise<{ src: string }> {
  // Asset uploads stay on raw `fetch` instead of the typed RPC client.
  // The worker's POST handler does size-aware multipart parsing that
  // doesn't fit `vValidator("form")`'s eager `parseBody()`; until the
  // server side switches to validator-friendly parsing, the call site
  // has nothing typed to consume.
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/assets`,
    {
      method: "POST",
      body: formData,
      signal: composeWithTimeout(abortSignal),
    },
  );
  if (!res.ok) {
    throw new Error(`Asset upload failed: ${res.status}`);
  }
  return (await res.json()) as { src: string };
}

async function defaultPushSnapshot(
  documentId: string,
  snapshot: TLStoreSnapshot,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  const res = await apiClient.api.documents[":id"].snapshot.$put(
    {
      param: { id: documentId },
      json: {
        snapshot: snapshot as unknown as Record<string, unknown>,
        expectedSnapshotVersion: 0,
      },
    },
    { init: { signal: composeWithTimeout(abortSignal) } },
  );
  if (!res.ok) {
    throw new Error(`Snapshot push failed: ${res.status}`);
  }
}

export interface ConvertLocalDocToSyncedParams {
  /** The local doc's id (the UUID generated when it was created). */
  documentId: string;
  localRepository: DocumentRepository;
  syncedRepository: DocumentRepository;
  uploadAsset?: (
    documentId: string,
    file: File,
    abortSignal?: AbortSignal,
  ) => Promise<{ src: string }>;
  pushSnapshot?: (
    documentId: string,
    snapshot: TLStoreSnapshot,
    abortSignal?: AbortSignal,
  ) => Promise<void>;
  /**
   * When provided, the migration checks the signal's aborted state at
   * each between-step boundary and throws its `reason` (an AbortError
   * by default). Fetch-backed steps also pass the signal through to
   * the HTTP layer so in-flight requests cancel eagerly.
   */
  abortSignal?: AbortSignal;
}

/**
 * Move a local IDB-backed document to the server. With UUID v7 ids
 * minted client-side, the local doc's id is also the canonical server
 * id — no remap is needed. The same `documentId` flows through every
 * step and the function's job reduces to "create the server row, push
 * the snapshot, delete the local copy."
 *
 * Steps:
 *   1. Load the local document.
 *   2. Compute a fractional-indexing key after the synced list's
 *      current tail so the migrated doc lands at the end.
 *   3. POST /api/documents — server inserts under the local id.
 *   4. Upload any inline `data:` URL assets to R2 and rewrite the
 *      snapshot's asset srcs accordingly.
 *   5. Push the rewritten snapshot into the document's Durable Object
 *      room via PUT /api/documents/:id/snapshot.
 *   6. Delete the local IDB entry.
 *
 * On failure after step 3 the local copy is intentionally preserved so
 * the user can retry. The half-created server row's `initializing_at`
 * marker keeps it invisible until the snapshot push lands, and the
 * server-side sweep cleans it up if the user gives up entirely.
 */
export async function convertLocalDocToSynced(
  params: ConvertLocalDocToSyncedParams,
): Promise<void> {
  const {
    documentId,
    localRepository,
    syncedRepository,
    uploadAsset = defaultUploadAsset,
    pushSnapshot = defaultPushSnapshot,
    abortSignal,
  } = params;

  abortSignal?.throwIfAborted();

  const local = await localRepository.get(documentId);
  if (!local) {
    throw new Error(`Local document ${documentId} not found`);
  }
  if (local.meta.source !== "local") {
    throw new Error(
      `Document ${documentId} is not a local document (source: ${local.meta.source})`,
    );
  }

  abortSignal?.throwIfAborted();

  // Append the migrated doc to the end of the synced list. Using the
  // synced repo's current tail as the "previous key" keeps each
  // migrated doc strictly after every existing synced doc.
  const syncedList = await syncedRepository.list();
  const newSortOrder = nextTailSortOrder(syncedList);

  abortSignal?.throwIfAborted();

  // POST /api/documents under the local id. The local doc's
  // `createdAt` is forwarded so the migrated doc keeps its original
  // on-device creation time; without that override the server would
  // stamp "now" and the timeline would reset.
  await syncedRepository.save({
    meta: {
      ...local.meta,
      sortOrder: newSortOrder,
      source: "synced",
    },
    snapshot: null,
  });

  if (local.snapshot) {
    abortSignal?.throwIfAborted();
    const rewritten = await uploadAssetDataUrls(local.snapshot, (file) =>
      uploadAsset(documentId, file, abortSignal),
    );
    abortSignal?.throwIfAborted();
    await pushSnapshot(documentId, rewritten, abortSignal);
  }

  abortSignal?.throwIfAborted();

  await localRepository.delete(documentId);
}
