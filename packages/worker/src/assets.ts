import type { Hono } from "hono";
import * as v from "valibot";
import type { AppBindings, AppContext } from "./types";

const SUPPORTED_ASSET_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/apng",
  "image/avif",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

const ASSET_EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/apng": ".apng",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
} as const satisfies Record<
  (typeof SUPPORTED_ASSET_CONTENT_TYPES)[number],
  string
>;

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ASSET_MULTIPART_OVERHEAD = 256 * 1024; // 256 KB
const MAX_ASSET_REQUEST_BODY_SIZE =
  MAX_ASSET_SIZE + MAX_ASSET_MULTIPART_OVERHEAD;
const STALE_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DOCUMENT_DELETE_BATCH_SIZE = 128;

const DOCUMENT_ASSET_PREFIX = "documents";
const ASSET_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

class InvalidMultipartFormDataError extends Error {
  constructor() {
    super("Invalid multipart form data");
    this.name = "InvalidMultipartFormDataError";
  }
}

const documentAssetUploadFieldsSchema = v.object({
  file: v.file("Missing file field"),
});

const documentAssetUploadFileSchema = v.pipe(
  v.file(),
  v.mimeType(SUPPORTED_ASSET_CONTENT_TYPES),
  v.maxSize(MAX_ASSET_SIZE),
);

const documentIdParamSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
});

const assetNameSchema = v.pipe(
  v.string(),
  v.regex(ASSET_NAME_PATTERN, "Invalid asset name"),
);

type SnapshotRecord = {
  id: string;
  typeName: string;
  props?: Record<string, unknown>;
};

function isSvgContentType(contentType: string) {
  return contentType === "image/svg+xml";
}

function isSupportedAssetContentType(contentType: string): boolean {
  return (SUPPORTED_ASSET_CONTENT_TYPES as readonly string[]).includes(
    contentType,
  );
}

function getAssetExtensionForContentType(contentType: string) {
  const ext =
    ASSET_EXTENSION_BY_CONTENT_TYPE[
      contentType as keyof typeof ASSET_EXTENSION_BY_CONTENT_TYPE
    ];
  if (!ext) {
    throw new Error(`Unsupported asset content type: ${contentType}`);
  }
  return ext;
}

function getDeclaredContentLength(contentLength: string | undefined) {
  if (!contentLength) {
    return null;
  }

  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getDocumentAssetPrefix(documentId: string) {
  return `${DOCUMENT_ASSET_PREFIX}/${documentId}/`;
}

function getDocumentAssetKey(documentId: string, assetName: string) {
  return `${getDocumentAssetPrefix(documentId)}${assetName}`;
}

function getDocumentAssetSrc(documentId: string, assetName: string) {
  return `/api/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetName)}`;
}

function getAssetNameFromDocumentAssetSrc(src: string, documentId: string) {
  try {
    const url = new URL(src, "https://anipres.invalid");
    const prefix = `/api/documents/${encodeURIComponent(documentId)}/assets/`;
    if (!url.pathname.startsWith(prefix)) {
      return null;
    }

    const encodedAssetName = url.pathname.slice(prefix.length);
    const assetName = decodeURIComponent(encodedAssetName);
    return v.safeParse(assetNameSchema, assetName).success ? assetName : null;
  } catch {
    return null;
  }
}

async function scheduleDocumentAssetGc(
  c: AppContext,
  documentId: string,
): Promise<void> {
  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(documentId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);
  await room.scheduleAssetGc(documentId);
}

async function scheduleDocumentDeletion(
  c: AppContext,
  documentId: string,
): Promise<void> {
  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(documentId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);
  await room.startDelete(documentId);
}

async function readRequestBodyWithLimit(request: Request, limit: number) {
  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function parseAssetUploadFormData(request: Request) {
  const body = await readRequestBodyWithLimit(
    request,
    MAX_ASSET_REQUEST_BODY_SIZE,
  );
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");

  try {
    return await new Request(request.url, {
      method: request.method,
      headers,
      body,
    }).formData();
  } catch {
    throw new InvalidMultipartFormDataError();
  }
}

async function documentExistsForUser(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  // Upload and asset-read paths only operate on active documents. Once a
  // delete starts, `deleting_at` closes the race where an in-flight upload
  // could otherwise recreate a blob after the delete sweep has already run.
  const document = await c.env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND user_id = ? AND deleting_at IS NULL",
  )
    .bind(documentId, userId)
    .first();
  return Boolean(document);
}

function normalizeRange(
  size: number,
  range?: R2Range,
): { offset: number; length: number } | undefined {
  if (!range) {
    return undefined;
  }

  if ("suffix" in range) {
    return {
      offset: Math.max(0, size - range.suffix),
      length: Math.min(size, range.suffix),
    };
  }

  const offset = Math.min(range.offset ?? 0, size);
  const length = Math.min(range.length ?? size - offset, size - offset);
  if (length <= 0) {
    return undefined;
  }

  return { offset, length };
}

function parseRangeHeader(rangeHeader: string, size: number): R2Range | null {
  const match = /^bytes=(.+)$/i.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const spec = match[1].trim();
  if (spec.length === 0 || spec.includes(",")) {
    return null;
  }

  const [rawStart, rawEnd] = spec.split("-", 2);
  if (rawStart === undefined || rawEnd === undefined) {
    return null;
  }

  if (rawStart === "") {
    if (!/^\d+$/.test(rawEnd)) {
      return null;
    }

    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return null;
    }

    return suffix > size ? { suffix: size } : { suffix };
  }

  if (!/^\d+$/.test(rawStart)) {
    return null;
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return null;
  }

  if (rawEnd === "") {
    return { offset: start };
  }

  if (!/^\d+$/.test(rawEnd)) {
    return null;
  }

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) {
    return null;
  }

  const clampedEnd = Math.min(end, size - 1);
  return { offset: start, length: clampedEnd - start + 1 };
}

function buildAssetHeaders(contentType: string, size: number, range?: R2Range) {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");

  const normalizedRange = normalizeRange(size, range);
  if (normalizedRange) {
    headers.set(
      "Content-Range",
      `bytes ${normalizedRange.offset}-${normalizedRange.offset + normalizedRange.length - 1}/${size}`,
    );
    headers.set("Content-Length", String(normalizedRange.length));
  } else {
    headers.set("Content-Length", String(size));
  }

  if (isSvgContentType(contentType)) {
    headers.set("Content-Security-Policy", "sandbox; script-src 'none'");
  }

  return headers;
}

function buildUnsatisfiableRangeHeaders(size: number) {
  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Range", `bytes */${size}`);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

async function deleteDocumentAssetPrefixBatch(
  bucket: R2Bucket,
  documentId: string,
  cursor?: string,
) {
  const prefix = getDocumentAssetPrefix(documentId);
  const result = await bucket.list({
    prefix,
    cursor,
    limit: DOCUMENT_DELETE_BATCH_SIZE,
  });
  if (result.objects.length > 0) {
    await bucket.delete(result.objects.map((object) => object.key));
  }

  return result.truncated ? result.cursor : null;
}

function getInClausePlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

async function insertDocumentAsset(
  env: AppContext["env"],
  documentId: string,
  assetName: string,
  contentType: string,
) {
  const now = Date.now();
  // Uploads start as stale until the synced document state actually references
  // them. That lets us reclaim abandoned uploads while keeping a grace window
  // for the editor to write the new asset into the room snapshot.
  await env.DB.prepare(
    `INSERT INTO assets (
       document_id,
       asset_name,
       content_type,
       created_at,
       last_seen_at,
       stale_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(documentId, assetName, contentType, now, now, now)
    .run();
}

async function clearReferencedDocumentAssets(
  env: AppContext["env"],
  documentId: string,
  assetNames: readonly string[],
  now: number,
) {
  if (assetNames.length === 0) {
    return;
  }

  await env.DB.prepare(
    `UPDATE assets
     SET last_seen_at = ?, stale_at = NULL
     WHERE document_id = ?
       AND asset_name IN (${getInClausePlaceholders(assetNames.length)})`,
  )
    .bind(now, documentId, ...assetNames)
    .run();
}

async function markUnreferencedDocumentAssetsStale(
  env: AppContext["env"],
  documentId: string,
  referencedAssetNames: readonly string[],
  now: number,
) {
  if (referencedAssetNames.length === 0) {
    await env.DB.prepare(
      `UPDATE assets
       SET stale_at = COALESCE(stale_at, ?)
       WHERE document_id = ?`,
    )
      .bind(now, documentId)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE assets
     SET stale_at = COALESCE(stale_at, ?)
     WHERE document_id = ?
       AND asset_name NOT IN (${getInClausePlaceholders(referencedAssetNames.length)})`,
  )
    .bind(now, documentId, ...referencedAssetNames)
    .run();
}

async function getNextDocumentAssetGcAt(
  env: AppContext["env"],
  documentId: string,
) {
  const row = await env.DB.prepare(
    `SELECT MIN(stale_at) AS stale_at
     FROM assets
     WHERE document_id = ? AND stale_at IS NOT NULL`,
  )
    .bind(documentId)
    .first<{ stale_at: number | null }>();
  return row?.stale_at === null || row?.stale_at === undefined
    ? null
    : row.stale_at + STALE_ASSET_RETENTION_MS;
}

export async function reconcileDocumentAssets(
  env: AppContext["env"],
  documentId: string,
  referencedAssetNames: readonly string[],
) {
  const now = Date.now();
  // The live room snapshot is only safe to treat as "currently referenced".
  // We mark missing assets stale here, then delete them later after a grace
  // period so undo/redo can still restore older asset URLs.
  await clearReferencedDocumentAssets(env, documentId, referencedAssetNames, now);
  await markUnreferencedDocumentAssetsStale(
    env,
    documentId,
    referencedAssetNames,
    now,
  );
  return getNextDocumentAssetGcAt(env, documentId);
}

export async function runDocumentAssetGc(
  env: AppContext["env"],
  documentId: string,
) {
  const cutoff = Date.now() - STALE_ASSET_RETENTION_MS;
  const expiredAssets = await env.DB.prepare(
    `SELECT asset_name
     FROM assets
     WHERE document_id = ?
       AND stale_at IS NOT NULL
       AND stale_at <= ?`,
  )
    .bind(documentId, cutoff)
    .all<{ asset_name: string }>();

  if (expiredAssets.results.length > 0) {
    const staleAssetNames = expiredAssets.results.map(
      ({ asset_name }) => asset_name,
    );
    try {
      // Re-check right before deleting blobs so a stale row that was revived by
      // a recent reconcile or undo does not lose its underlying object.
      const currentExpiredAssets = await env.DB.prepare(
        `SELECT asset_name
         FROM assets
         WHERE document_id = ?
           AND stale_at IS NOT NULL
           AND stale_at <= ?
           AND asset_name IN (${getInClausePlaceholders(staleAssetNames.length)})`,
      )
        .bind(documentId, cutoff, ...staleAssetNames)
        .all<{ asset_name: string }>();
      const keys = currentExpiredAssets.results.map(({ asset_name }) =>
        getDocumentAssetKey(documentId, asset_name),
      );
      if (keys.length === 0) {
        return getNextDocumentAssetGcAt(env, documentId);
      }

      await env.ASSETS.delete(keys);
      await env.DB.prepare(
        `DELETE FROM assets
         WHERE document_id = ?
           AND stale_at IS NOT NULL
           AND stale_at <= ?
           AND asset_name IN (${getInClausePlaceholders(staleAssetNames.length)})`,
      )
        .bind(documentId, cutoff, ...staleAssetNames)
        .run();
    } catch (error) {
      // Keep stale rows so the next alarm can retry blob deletion instead of
      // breaking the GC chain on a transient R2 failure.
      console.error("Failed to delete stale document assets", error);
    }
  }

  return getNextDocumentAssetGcAt(env, documentId);
}

export async function isDocumentDeleting(
  env: AppContext["env"],
  documentId: string,
) {
  const row = await env.DB.prepare(
    "SELECT deleting_at FROM documents WHERE id = ?",
  )
    .bind(documentId)
    .first<{ deleting_at: number | null }>();
  return row?.deleting_at !== null && row?.deleting_at !== undefined;
}

export function getReferencedDocumentAssetNames(
  snapshot: {
    documents: Array<{ state: SnapshotRecord }>;
  },
  documentId: string,
) {
  const records = snapshot.documents.map((document) => document.state);
  const assetsById = new Map<string, SnapshotRecord>();
  const referencedAssetIds = new Set<string>();

  for (const record of records) {
    if (record.typeName === "asset") {
      assetsById.set(record.id, record);
      continue;
    }

    if (record.typeName !== "shape") {
      continue;
    }

    const props = record.props;
    if (!props) {
      continue;
    }

    for (const key of ["assetId", "assetIdLight", "assetIdDark"] as const) {
      const assetId = props[key];
      if (typeof assetId === "string" && assetId.length > 0) {
        referencedAssetIds.add(assetId);
      }
    }
  }

  const assetNames = new Set<string>();
  for (const assetId of referencedAssetIds) {
    const asset = assetsById.get(assetId) as
      | (SnapshotRecord & { props?: { src?: unknown } })
      | undefined;
    const src = asset?.props?.src;
    if (typeof src !== "string") {
      continue;
    }

    const assetName = getAssetNameFromDocumentAssetSrc(src, documentId);
    if (assetName) {
      assetNames.add(assetName);
    }
  }

  return Array.from(assetNames).sort();
}

export async function finalizeDeletingDocument(
  env: AppContext["env"],
  documentId: string,
  cursor?: string,
) {
  const document = await env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND deleting_at IS NOT NULL",
  )
    .bind(documentId)
    .first();
  if (!document) {
    return { completed: true, nextCursor: null };
  }

  const nextCursor = await deleteDocumentAssetPrefixBatch(
    env.ASSETS,
    documentId,
    cursor,
  );
  if (nextCursor !== null) {
    return { completed: false, nextCursor };
  }

  await env.DB.prepare(
    "DELETE FROM documents WHERE id = ? AND deleting_at IS NOT NULL",
  )
    .bind(documentId)
    .run();
  return { completed: true, nextCursor: null };
}

export async function startDocumentDeletion(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  const { meta } = await c.env.DB.prepare(
    `UPDATE documents
     SET deleting_at = ?
     WHERE id = ? AND user_id = ? AND deleting_at IS NULL`,
  )
    .bind(Date.now(), documentId, userId)
    .run();
  if (meta.changes === 0) {
    return;
  }

  try {
    // Prefix cleanup can take long enough to exceed a request budget. Hand the
    // actual delete work to the document DO so `deleting_at` can remain a
    // retryable state until the R2 sweep finishes successfully.
    await scheduleDocumentDeletion(c, documentId);
  } catch (error) {
    // Only roll back the deleting state if this call actually transitioned the
    // document into deletion. Existing delete retries must stay hidden from
    // active routes so uploads/connects cannot race against unfinished cleanup.
    await c.env.DB.prepare(
      "UPDATE documents SET deleting_at = NULL WHERE id = ? AND user_id = ? AND deleting_at IS NOT NULL",
    )
      .bind(documentId, userId)
      .run();
    throw error;
  }
}

export function registerAssetRoutes(app: Hono<AppBindings>) {
  app.post("/api/documents/:id/assets", async (c) => {
    const userId = c.get("userId");
    const paramsResult = v.safeParse(documentIdParamSchema, {
      id: c.req.param("id"),
    });
    if (!paramsResult.success) {
      return c.json(
        { error: "Invalid document id", details: paramsResult.issues },
        400,
      );
    }

    const { id: documentId } = paramsResult.output;
    if (!(await documentExistsForUser(c, userId, documentId))) {
      return c.json({ error: "Not found" }, 404);
    }

    const declaredContentLength = getDeclaredContentLength(
      c.req.header("Content-Length"),
    );
    if (
      declaredContentLength !== null &&
      declaredContentLength > MAX_ASSET_REQUEST_BODY_SIZE
    ) {
      return c.json({ error: "File too large" }, 413);
    }

    let formData: FormData;
    try {
      formData = await parseAssetUploadFormData(c.req.raw);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "File too large" }, 413);
      }
      if (error instanceof InvalidMultipartFormDataError) {
        return c.json({ error: "Invalid multipart form data" }, 400);
      }
      throw error;
    }

    const uploadFieldsResult = v.safeParse(documentAssetUploadFieldsSchema, {
      file: formData.get("file"),
    });
    if (!uploadFieldsResult.success) {
      return c.json(
        {
          error: "Invalid asset upload fields",
          details: uploadFieldsResult.issues,
        },
        400,
      );
    }

    const { file: uploadFile } = uploadFieldsResult.output;
    const uploadFileResult = v.safeParse(
      documentAssetUploadFileSchema,
      uploadFile,
    );
    if (!uploadFileResult.success) {
      return c.json(
        {
          error:
            uploadFile.size > MAX_ASSET_SIZE
              ? "File too large"
              : "Unsupported asset type",
          details: uploadFileResult.issues,
        },
        uploadFile.size > MAX_ASSET_SIZE ? 413 : 400,
      );
    }

    // Derive the suffix from the validated MIME type instead of trusting the
    // uploaded filename. That keeps asset keys bounded and predictable even if
    // a client sends a pathological or misleading name.
    const ext = getAssetExtensionForContentType(uploadFile.type);
    const assetName = `${crypto.randomUUID()}${ext}`;
    const key = getDocumentAssetKey(documentId, assetName);

    try {
      await c.env.ASSETS.put(key, uploadFile.stream(), {
        httpMetadata: { contentType: uploadFile.type },
      });
      if (!(await documentExistsForUser(c, userId, documentId))) {
        await c.env.ASSETS.delete(key);
        return c.json({ error: "Not found" }, 404);
      }
      await insertDocumentAsset(c.env, documentId, assetName, uploadFile.type);
    } catch (error) {
      await c.env.ASSETS.delete(key);
      throw error;
    }

    c.executionCtx.waitUntil(
      scheduleDocumentAssetGc(c, documentId).catch((error) => {
        console.error("Failed to schedule document asset GC", error);
      }),
    );

    return c.json({
      assetName,
      src: getDocumentAssetSrc(documentId, assetName),
    });
  });

  app.get("/api/documents/:id/assets/:assetName", async (c) => {
    const userId = c.get("userId");
    const paramsResult = v.safeParse(documentIdParamSchema, {
      id: c.req.param("id"),
    });
    if (!paramsResult.success) {
      return c.json(
        { error: "Invalid document id", details: paramsResult.issues },
        400,
      );
    }

    const { id: documentId } = paramsResult.output;
    if (!(await documentExistsForUser(c, userId, documentId))) {
      return c.json({ error: "Not found" }, 404);
    }

    const assetName = c.req.param("assetName");
    const assetNameResult = v.safeParse(assetNameSchema, assetName);
    if (!assetNameResult.success) {
      return c.json({ error: "Not found" }, 404);
    }

    const key = getDocumentAssetKey(documentId, assetNameResult.output);
    const rangeHeader = c.req.header("Range");
    let metadata: R2Object | null = null;
    let object: R2ObjectBody | null;
    if (rangeHeader) {
      const rangedMetadata = await c.env.ASSETS.head(key);
      if (!rangedMetadata) {
        return c.json({ error: "Not found" }, 404);
      }
      metadata = rangedMetadata;
      const range = parseRangeHeader(rangeHeader, rangedMetadata.size);
      if (!range) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: buildUnsatisfiableRangeHeaders(rangedMetadata.size),
        });
      }

      object = await c.env.ASSETS.get(key, { range });
    } else {
      object = await c.env.ASSETS.get(key);
    }

    if (!object) {
      return c.json({ error: "Not found" }, 404);
    }

    const contentType =
      object.httpMetadata?.contentType ?? metadata?.httpMetadata?.contentType;
    if (!contentType || !isSupportedAssetContentType(contentType)) {
      return c.json({ error: "Not found" }, 404);
    }

    const headers = buildAssetHeaders(contentType, object.size, object.range);
    const status = rangeHeader && object.range ? 206 : 200;

    return new Response(object.body, { status, headers });
  });
}
