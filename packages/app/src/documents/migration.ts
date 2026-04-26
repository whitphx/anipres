import type { TLStoreSnapshot } from "tldraw";
import type { DocumentRepository } from "./repository";
import type { DocumentData } from "./types";
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

/**
 * Scan a snapshot for inline `data:` URL assets, upload each via the
 * injected `uploadFile` callback, and return a new snapshot with the
 * asset srcs rewritten to the uploaded URLs. Snapshots with no data-URL
 * assets are returned unchanged.
 *
 * Uploads run in parallel. On partial failure some assets may still
 * reach R2 even though the promise rejects; the worker's asset GC
 * reconciles orphans against the live snapshot and cleans them up.
 */
export async function uploadAssetDataUrls(
  snapshot: TLStoreSnapshot,
  uploadFile: (file: File) => Promise<{ src: string }>,
): Promise<TLStoreSnapshot> {
  const assets = findDataUrlAssets(snapshot);
  if (assets.length === 0) return snapshot;

  // The File constructor requires a non-empty name, but the server
  // derives the final asset key's extension from the validated MIME
  // type and ignores this filename entirely (see
  // packages/worker/src/assets.ts). Passing the record id is enough.
  const entries = await Promise.all(
    assets.map(async (asset) => {
      const file = await dataUrlToFile(asset.dataUrl, asset.recordId);
      const { src } = await uploadFile(file);
      return [asset.recordId, src] as const;
    }),
  );
  return rewriteAssetSrcs(snapshot, new Map(entries));
}

// Migration HTTP calls can stall on a dead connection without this; the
// rest of the app hits websocket endpoints where RTT limits are
// enforced differently. 60s is generous for the asset upload case
// (a 10 MB payload on a slow network takes time) but short enough to
// surface as a visible failure rather than an indefinite spinner.
const MIGRATION_FETCH_TIMEOUT_MS = 60_000;

function composeWithTimeout(userSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(MIGRATION_FETCH_TIMEOUT_MS);
  return userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
}

async function defaultUploadAsset(
  documentId: string,
  file: File,
  abortSignal?: AbortSignal,
): Promise<{ src: string }> {
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
  abortSignal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/snapshot`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot,
        expectedSnapshotVersion: 0,
      }),
      signal: composeWithTimeout(abortSignal),
    },
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
 * Move a local IDB-backed document to the server. The server allocates
 * a new id (and slug) at creation time; the local id is discarded once
 * the migration completes.
 *
 * Steps:
 *   1. Load the local document.
 *   2. Compute a fractional-indexing key after the synced list's
 *      current tail so the migrated doc lands at the end.
 *   3. POST /api/documents to create the server-side row. Server
 *      returns the canonical id+slug.
 *   4. Upload any inline `data:` URL assets to R2 under the *new*
 *      server id and rewrite the snapshot's asset srcs accordingly.
 *   5. Push the rewritten snapshot into the document's Durable Object
 *      room via PUT /api/documents/:id/snapshot (with the new id).
 *   6. Delete the local IDB entry under the original local id.
 *
 * Returns the new doc data so callers can swap their `activeDocumentId`
 * to the server-allocated value.
 *
 * On failure after step 3 the local copy is intentionally preserved so
 * the user can retry. The half-created server row is left for the same
 * reason — the user can manually delete it, or a retry will create
 * another one (the local→synced relationship is identified only by
 * what the user converts, not by id).
 */
export async function convertLocalDocToSynced(
  params: ConvertLocalDocToSyncedParams,
): Promise<DocumentData> {
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
  if (local.meta.origin !== "local") {
    throw new Error(
      `Document ${documentId} is not a local document (origin: ${local.meta.origin})`,
    );
  }

  abortSignal?.throwIfAborted();

  // Append the migrated doc to the end of the synced list. Using the
  // synced repo's current tail as the "previous key" keeps each
  // migrated doc strictly after every existing synced doc.
  const syncedList = await syncedRepository.list();
  const newSortOrder = nextTailSortOrder(syncedList);

  abortSignal?.throwIfAborted();

  // POST /api/documents allocates the server id and slug. The local
  // id and slug-less metadata are passed-through fields; the server
  // ignores `id` and stamps its own `slug`.
  //
  // createdAt is preserved from the local doc so migrated docs keep
  // their original creation time; updatedAt advances to "now."
  const synced = await syncedRepository.create({
    meta: {
      ...local.meta,
      origin: "synced",
      sortOrder: newSortOrder,
      updatedAt: Date.now(),
    },
    snapshot: null,
  });
  const serverId = synced.meta.id;

  if (local.snapshot) {
    abortSignal?.throwIfAborted();
    const rewritten = await uploadAssetDataUrls(local.snapshot, (file) =>
      uploadAsset(serverId, file, abortSignal),
    );
    abortSignal?.throwIfAborted();
    await pushSnapshot(serverId, rewritten, abortSignal);
  }

  abortSignal?.throwIfAborted();

  await localRepository.delete(documentId);

  return synced;
}
