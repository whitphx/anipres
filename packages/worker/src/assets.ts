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

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ASSET_MULTIPART_OVERHEAD = 256 * 1024; // 256 KB
const MAX_ASSET_REQUEST_BODY_SIZE =
  MAX_ASSET_SIZE + MAX_ASSET_MULTIPART_OVERHEAD;
const STALE_ASSET_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  const response = await room.fetch(
    `https://document-sync-room/internal/schedule-asset-gc/${encodeURIComponent(documentId)}`,
    {
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      `Document asset GC scheduling failed: ${response.status} ${response.statusText}`,
    );
  }
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
  const document = await c.env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND user_id = ?",
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

async function deleteDocumentAssetPrefix(bucket: R2Bucket, documentId: string) {
  const prefix = getDocumentAssetPrefix(documentId);
  let cursor: string | undefined;

  while (true) {
    const result = await bucket.list({ prefix, cursor });
    if (result.objects.length > 0) {
      await bucket.delete(result.objects.map((object) => object.key));
    }

    if (!result.truncated) {
      break;
    }

    cursor = result.cursor;
  }
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
    const keys = expiredAssets.results.map(({ asset_name }) =>
      getDocumentAssetKey(documentId, asset_name),
    );
    await env.ASSETS.delete(keys);
    await env.DB.prepare(
      `DELETE FROM assets
       WHERE document_id = ?
         AND stale_at IS NOT NULL
         AND stale_at <= ?`,
    )
      .bind(documentId, cutoff)
      .run();
  }

  return getNextDocumentAssetGcAt(env, documentId);
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

export async function deleteDocumentAndAssets(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  // Delete document-scoped blobs before removing the document row. If R2
  // deletion fails, we want the document and its asset metadata to remain so
  // the delete can be retried instead of leaking orphaned blobs permanently.
  await deleteDocumentAssetPrefix(c.env.ASSETS, documentId);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?")
    .bind(documentId, userId)
    .run();
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

    const rawExt = uploadFile.name.includes(".")
      ? uploadFile.name.split(".").pop()!.toLowerCase()
      : "";
    const ext = /^[a-z0-9]+$/.test(rawExt) ? `.${rawExt}` : "";
    const assetName = `${crypto.randomUUID()}${ext}`;
    const key = getDocumentAssetKey(documentId, assetName);

    try {
      await c.env.ASSETS.put(key, uploadFile.stream(), {
        httpMetadata: { contentType: uploadFile.type },
      });
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
    let object: R2ObjectBody | null;
    if (rangeHeader) {
      try {
        object = await c.env.ASSETS.get(key, { range: c.req.raw.headers });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.toLowerCase().includes("range")
        ) {
          const metadata = await c.env.ASSETS.head(key);
          if (!metadata) {
            return c.json({ error: "Not found" }, 404);
          }
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: buildUnsatisfiableRangeHeaders(metadata.size),
          });
        }
        throw error;
      }
    } else {
      object = await c.env.ASSETS.get(key);
    }

    if (!object) {
      return c.json({ error: "Not found" }, 404);
    }

    const contentType =
      object.httpMetadata?.contentType ?? "application/octet-stream";
    const headers = buildAssetHeaders(contentType, object.size, object.range);
    const status = rangeHeader && object.range ? 206 : 200;

    return new Response(object.body, { status, headers });
  });
}
