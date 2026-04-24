import type { TLStoreSnapshot } from "tldraw";
import type { DocumentRepository } from "./repository";

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/apng": "apng",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Parse a `data:` URL into a File. Supports base64 payloads (the common
 * case for images) and URL-encoded text payloads (the fallback for SVG
 * and similar text formats).
 */
export function dataUrlToFile(dataUrl: string, filename: string): File {
  const match = dataUrl.match(/^data:([^;,]+)((?:;[^,]*)*),(.*)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  const [, mimeType, params, payload] = match;
  const isBase64 = params.split(";").some((p) => p === "base64");
  let bytes: Uint8Array;
  if (isBase64) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return new File([bytes], filename, { type: mimeType });
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
  mimeType: string;
}

export function findDataUrlAssets(snapshot: TLStoreSnapshot): DataUrlAsset[] {
  const results: DataUrlAsset[] = [];
  for (const [id, record] of Object.entries(snapshot.store)) {
    if (!isAssetRecord(record)) continue;
    const src = record.props.src;
    if (!isDataUrl(src)) continue;
    const mimeType =
      src.match(/^data:([^;,]+)/)?.[1] ?? "application/octet-stream";
    results.push({ recordId: id, dataUrl: src, mimeType });
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
 */
export async function uploadAssetDataUrls(
  snapshot: TLStoreSnapshot,
  uploadFile: (file: File) => Promise<{ src: string }>,
): Promise<TLStoreSnapshot> {
  const assets = findDataUrlAssets(snapshot);
  if (assets.length === 0) return snapshot;

  const rewrites = new Map<string, string>();
  for (const asset of assets) {
    const ext = MIME_TYPE_EXTENSIONS[asset.mimeType] ?? "bin";
    const filename = `${asset.recordId}.${ext}`;
    const file = dataUrlToFile(asset.dataUrl, filename);
    const { src } = await uploadFile(file);
    rewrites.set(asset.recordId, src);
  }
  return rewriteAssetSrcs(snapshot, rewrites);
}

async function defaultUploadAsset(
  documentId: string,
  file: File,
): Promise<{ src: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}/assets`,
    {
      method: "POST",
      body: formData,
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
    },
  );
  if (!res.ok) {
    throw new Error(`Snapshot push failed: ${res.status}`);
  }
}

export interface ConvertLocalDocToSyncedParams {
  documentId: string;
  localRepository: DocumentRepository;
  syncedRepository: DocumentRepository;
  uploadAsset?: (documentId: string, file: File) => Promise<{ src: string }>;
  pushSnapshot?: (
    documentId: string,
    snapshot: TLStoreSnapshot,
  ) => Promise<void>;
}

/**
 * Move a local IDB-backed document to the server under the same id.
 *
 * Steps:
 *   1. Load the local document.
 *   2. Create server-side metadata via PUT /api/documents/:id
 *      (with the synced repository's save).
 *   3. Upload any inline `data:` URL assets to R2 and rewrite the
 *      snapshot's asset srcs to point at the uploaded URLs.
 *   4. Push the rewritten snapshot into the document's Durable Object
 *      room via PUT /api/documents/:id/snapshot.
 *   5. Delete the local IDB entry.
 *
 * On failure after step 2 the local copy is intentionally preserved so
 * the user can retry. Server-side metadata left over from a partial run
 * is harmless: the next attempt is an upsert and the snapshot push with
 * `expectedSnapshotVersion: 0` will either succeed (fresh DO room) or
 * no-op (409) if the prior attempt got that far.
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
  } = params;

  const local = await localRepository.get(documentId);
  if (!local) {
    throw new Error(`Local document ${documentId} not found`);
  }
  if (local.meta.origin !== "local") {
    throw new Error(
      `Document ${documentId} is not a local document (origin: ${local.meta.origin})`,
    );
  }

  // Compute an order value against the synced repo so the migrated doc
  // does not collide with an existing server doc's order.
  const syncedList = await syncedRepository.list();
  const maxOrder = syncedList.reduce((max, d) => Math.max(max, d.order), 0);
  const now = Date.now();

  await syncedRepository.save({
    meta: {
      ...local.meta,
      origin: "synced",
      order: maxOrder + 1,
      updatedAt: now,
    },
    snapshot: null,
  });

  if (local.snapshot) {
    const rewritten = await uploadAssetDataUrls(local.snapshot, (file) =>
      uploadAsset(documentId, file),
    );
    await pushSnapshot(documentId, rewritten);
  }

  await localRepository.delete(documentId);
}
