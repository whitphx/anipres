import type { Hono } from "hono";
import { file, maxSize, mimeType, object, pipe, string } from "valibot";
import type { AppBindings, AppContext, Env } from "./types";
import { validateWithSchema } from "./validation";

const SUPPORTED_ASSET_CONTENT_TYPES = [
  // Images (matches tldraw DEFAULT_SUPPORTED_IMAGE_TYPES)
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/apng",
  "image/avif",
  "image/svg+xml",
  // Videos (matches tldraw DEFAULT_SUPPORTED_VIDEO_TYPES)
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ASSET_MULTIPART_OVERHEAD = 256 * 1024; // 256 KB
const MAX_ASSET_REQUEST_BODY_SIZE =
  MAX_ASSET_SIZE + MAX_ASSET_MULTIPART_OVERHEAD;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

type AssetKeyRow = {
  asset_key: string;
};

type DocumentAssetRow = {
  asset_key: string;
  stale_at: number | null;
};

type MinStaleAtRow = {
  stale_at: number | null;
};

type AssetEnv = Pick<Env, "ASSETS" | "DB">;

const MANAGED_ASSET_PATH_PREFIX = "/api/assets/";
const MANAGED_ASSET_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;
const MANAGED_ASSET_RECORD_TYPES = new Set(["image", "video"]);
const ASSET_ID_PROP_PREFIX = "assetId";
const ASSET_STALE_GRACE_PERIOD_MS = 5 * 60 * 1000;

const assetUploadFieldsSchema = object({
  file: file("Missing file field"),
  documentId: string("Missing documentId field"),
});

const assetUploadFileSchema = pipe(
  // Validate file metadata after multipart parsing. The stream-size cap above
  // still protects request processing before we materialize the File object.
  file(),
  mimeType(SUPPORTED_ASSET_CONTENT_TYPES),
  maxSize(MAX_ASSET_SIZE),
);

function isSvgContentType(contentType: string) {
  return contentType === "image/svg+xml";
}

function isManagedAssetKey(key: string) {
  return MANAGED_ASSET_KEY_PATTERN.test(key);
}

function getDeclaredContentLength(contentLength: string | undefined) {
  if (!contentLength) {
    return null;
  }

  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  }).formData();
}

function makePlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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

async function notifyDocumentAssetReconciliation(
  c: AppContext,
  documentId: string,
) {
  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(documentId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);

  // Uploads add D1 refs before the synced room necessarily contains the new
  // asset record. Tell the DO to reconcile immediately so interrupted uploads
  // still become stale and eligible for alarm-driven GC.
  await room.fetch(
    new Request(
      `https://document-sync-room/internal/reconcile-assets?documentId=${encodeURIComponent(documentId)}`,
      { method: "POST" },
    ),
  );
}

function scheduleDocumentAssetReconciliation(c: AppContext, documentId: string) {
  c.executionCtx.waitUntil(
    notifyDocumentAssetReconciliation(c, documentId).catch((error) => {
      console.error("Failed to notify document asset reconciliation", error);
    }),
  );
}

async function getDocumentAssetRows(
  env: AssetEnv,
  userId: number,
  documentId: string,
) {
  const { results } = await env.DB.prepare(
    "SELECT asset_key, stale_at FROM document_assets WHERE document_id = ? AND user_id = ?",
  )
    .bind(documentId, userId)
    .all<DocumentAssetRow>();
  return results;
}

async function getUserOwnedAssetKeys(
  env: AssetEnv,
  userId: number,
  assetKeys: string[],
) {
  if (assetKeys.length === 0) {
    return [];
  }

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT asset_key
     FROM document_assets
     WHERE user_id = ? AND asset_key IN (${makePlaceholders(assetKeys.length)})`,
  )
    .bind(userId, ...assetKeys)
    .all<AssetKeyRow>();

  return results.map((row) => row.asset_key);
}

async function upsertDocumentAssetRefs(
  env: AssetEnv,
  userId: number,
  documentId: string,
  assetKeys: string[],
) {
  if (assetKeys.length === 0) {
    return;
  }

  const now = Date.now();
  await env.DB.batch(
    assetKeys.map((assetKey) =>
      env.DB.prepare(
        `INSERT INTO document_assets (document_id, asset_key, user_id, created_at, stale_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(document_id, asset_key) DO UPDATE SET stale_at = NULL`,
      ).bind(documentId, assetKey, userId, now),
    ),
  );
}

async function markDocumentAssetRefsStale(
  env: AssetEnv,
  userId: number,
  documentId: string,
  assetKeys: string[],
) {
  if (assetKeys.length === 0) {
    return;
  }

  const now = Date.now();
  await env.DB.batch(
    assetKeys.map((assetKey) =>
      env.DB.prepare(
        `UPDATE document_assets
         SET stale_at = COALESCE(stale_at, ?)
         WHERE document_id = ? AND user_id = ? AND asset_key = ?`,
      ).bind(now, documentId, userId, assetKey),
    ),
  );
}

async function deleteExpiredStaleDocumentAssetRefs(
  env: AssetEnv,
  userId: number,
  documentId: string,
) {
  const cutoff = Date.now() - ASSET_STALE_GRACE_PERIOD_MS;
  const { results } = await env.DB.prepare(
    `SELECT asset_key
     FROM document_assets
     WHERE document_id = ? AND user_id = ? AND stale_at IS NOT NULL AND stale_at <= ?`,
  )
    .bind(documentId, userId, cutoff)
    .all<AssetKeyRow>();

  const expiredKeys = results.map((row) => row.asset_key);
  if (expiredKeys.length === 0) {
    return [];
  }

  await env.DB.prepare(
    `DELETE FROM document_assets
     WHERE document_id = ? AND user_id = ? AND stale_at IS NOT NULL AND stale_at <= ?`,
  )
    .bind(documentId, userId, cutoff)
    .run();

  return expiredKeys;
}

async function getNextDocumentAssetGcAt(
  env: AssetEnv,
  userId: number,
  documentId: string,
) {
  const row = await env.DB.prepare(
    `SELECT MIN(stale_at) AS stale_at
     FROM document_assets
     WHERE document_id = ? AND user_id = ? AND stale_at IS NOT NULL`,
  )
    .bind(documentId, userId)
    .first<MinStaleAtRow>();

  if (!row?.stale_at) {
    return null;
  }

  return row.stale_at + ASSET_STALE_GRACE_PERIOD_MS;
}

export async function runDocumentAssetGc(
  env: AssetEnv,
  userId: number,
  documentId: string,
) {
  const expiredStaleKeys = await deleteExpiredStaleDocumentAssetRefs(
    env,
    userId,
    documentId,
  );
  await deleteUnreferencedAssets(env, expiredStaleKeys);

  return {
    nextGcAt: await getNextDocumentAssetGcAt(env, userId, documentId),
  };
}

async function deleteUnreferencedAssets(env: AssetEnv, assetKeys: string[]) {
  const dedupedAssetKeys = Array.from(
    new Set(assetKeys.filter(isManagedAssetKey)),
  );
  if (dedupedAssetKeys.length === 0) {
    return;
  }

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT asset_key
     FROM document_assets
     WHERE asset_key IN (${makePlaceholders(dedupedAssetKeys.length)})`,
  )
    .bind(...dedupedAssetKeys)
    .all<AssetKeyRow>();

  const referencedKeys = new Set(results.map((row) => row.asset_key));
  const orphanedKeys = dedupedAssetKeys.filter(
    (key) => !referencedKeys.has(key),
  );
  if (orphanedKeys.length === 0) {
    return;
  }

  try {
    await env.ASSETS.delete(orphanedKeys);
  } catch (error) {
    console.error("Failed to delete orphaned R2 assets", error);
  }
}

function getManagedAssetKeyFromSrc(src: string) {
  try {
    const url = new URL(src, "https://anipres.invalid");
    if (!url.pathname.startsWith(MANAGED_ASSET_PATH_PREFIX)) {
      return null;
    }

    return decodeURIComponent(
      url.pathname.slice(MANAGED_ASSET_PATH_PREFIX.length),
    );
  } catch {
    return null;
  }
}

function getShapeAssetIds(record: unknown) {
  if (!isObject(record) || record.typeName !== "shape" || !isObject(record.props)) {
    return [];
  }

  return Object.entries(record.props).flatMap(([key, value]) => {
    if (
      key.startsWith(ASSET_ID_PROP_PREFIX) &&
      typeof value === "string" &&
      value.startsWith("asset:")
    ) {
      return [value];
    }

    return [];
  });
}

function getAssetRecord(record: unknown) {
  if (
    !isObject(record) ||
    typeof record.id !== "string" ||
    record.typeName !== "asset" ||
    !MANAGED_ASSET_RECORD_TYPES.has(String(record.type)) ||
    !isObject(record.props)
  ) {
    return null;
  }

  return {
    id: record.id,
    props: record.props,
  };
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
  // This endpoint is session-protected under /api/*. Marking it `public` would
  // let a shared cache replay a response without rerunning the auth gate.
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
    // SVG is executable when opened as a top-level same-origin document. Keep
    // SVG uploads working, but sandbox direct navigations so the asset cannot
    // run script or inherit the main app origin.
    headers.set("Content-Security-Policy", "sandbox; script-src 'none'");
  }

  return headers;
}

/**
 * Collect asset keys for a document, then delete the document row (which
 * CASCADE-deletes its document_assets refs), then GC orphaned R2 objects.
 *
 * This ordering ensures that if the document DELETE fails, no assets are lost.
 * If only the R2 GC fails, we have harmless orphaned blobs but no data loss.
 */
export async function deleteDocumentAndAssets(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  const [deletedAssetsResult, deletedDocumentResult] = await c.env.DB.batch([
    // Delete and return the current refs in the same D1 batch as the document
    // delete so a concurrent upload cannot land between "collect keys" and the
    // actual deletion step.
    c.env.DB.prepare(
      `DELETE FROM document_assets
       WHERE document_id = ? AND user_id = ?
         AND EXISTS (
           SELECT 1 FROM documents WHERE id = ? AND user_id = ?
         )
       RETURNING asset_key`,
    ).bind(documentId, userId, documentId, userId),
    c.env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?").bind(
      documentId,
      userId,
    ),
  ]);
  if (deletedDocumentResult.meta.changes > 0) {
    const assetKeys = deletedAssetsResult.results
      .map((row) =>
        isObject(row) && typeof row.asset_key === "string" ? row.asset_key : null,
      )
      .filter((assetKey): assetKey is string => assetKey !== null);
    await deleteUnreferencedAssets(c.env, assetKeys);
  }
}

export async function getDocumentOwnerUserId(
  env: Pick<Env, "DB">,
  documentId: string,
) {
  const row = await env.DB.prepare("SELECT user_id FROM documents WHERE id = ?")
    .bind(documentId)
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

export function getManagedAssetKeysFromSnapshot(snapshot: unknown) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.documents)) {
    return [];
  }

  const assetRecords = new Map<string, Record<string, unknown>>();
  const referencedAssetIds = new Set<string>();

  for (const document of snapshot.documents) {
    if (!isObject(document) || !("state" in document)) {
      continue;
    }

    const record = document.state;
    const assetRecord = getAssetRecord(record);
    if (assetRecord) {
      assetRecords.set(assetRecord.id, assetRecord.props);
      continue;
    }

    getShapeAssetIds(record).forEach((assetId) => {
      referencedAssetIds.add(assetId);
    });
  }

  const keys = new Set<string>();
  referencedAssetIds.forEach((assetId) => {
    const src = assetRecords.get(assetId)?.src;
    if (typeof src !== "string") {
      return;
    }

    const assetKey = getManagedAssetKeyFromSrc(src);
    if (assetKey && isManagedAssetKey(assetKey)) {
      keys.add(assetKey);
    }
  });

  return Array.from(keys).sort();
}

export async function reconcileDocumentAssetRefs(
  env: AssetEnv,
  userId: number,
  documentId: string,
  requestedKeys: string[],
) {
  const dedupedKeys = Array.from(
    new Set(requestedKeys.filter((key) => isManagedAssetKey(key))),
  );
  const nextKeys = await getUserOwnedAssetKeys(env, userId, dedupedKeys);
  const currentRows = await getDocumentAssetRows(env, userId, documentId);

  const nextKeySet = new Set(nextKeys);
  const staleKeys = currentRows
    .filter((row) => !nextKeySet.has(row.asset_key))
    .map((row) => row.asset_key);

  // Uploads hit R2 and D1 before the synced room necessarily reflects the new
  // shape/asset records. Mark missing refs stale first and only GC them after a
  // grace period so reconciliation does not race freshly uploaded assets.
  await upsertDocumentAssetRefs(env, userId, documentId, nextKeys);
  await markDocumentAssetRefsStale(env, userId, documentId, staleKeys);
  return runDocumentAssetGc(env, userId, documentId);
}

export function registerAssetRoutes(app: Hono<AppBindings>) {
  app.post("/api/assets", async (c) => {
    const userId = c.get("userId");
    const declaredContentLength = getDeclaredContentLength(
      c.req.header("Content-Length"),
    );
    if (
      declaredContentLength !== null &&
      declaredContentLength > MAX_ASSET_REQUEST_BODY_SIZE
    ) {
      // `parseBody()` materializes the multipart payload before we can inspect
      // the File object, so reject obviously oversized requests from the
      // declared Content-Length before parsing. Keep the later File.size check
      // because the header may be absent or imprecise.
      return c.json({ error: "File too large" }, 413);
    }

    let formData: FormData;
    try {
      formData = await parseAssetUploadFormData(c.req.raw);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "File too large" }, 413);
      }
      throw error;
    }

    const uploadFieldsResult = validateWithSchema(assetUploadFieldsSchema, {
      file: formData.get("file"),
      documentId: formData.get("documentId"),
    });
    if (!uploadFieldsResult.success) {
      return c.json(
        { error: "Invalid asset upload fields", details: uploadFieldsResult.issues },
        400,
      );
    }

    const { file, documentId } = uploadFieldsResult.output;
    if (!(await documentExistsForUser(c, userId, documentId))) {
      return c.json({ error: "Not found" }, 404);
    }

    const uploadFileResult = validateWithSchema(assetUploadFileSchema, file);
    if (!uploadFileResult.success) {
      return c.json(
        {
          error: file.size > MAX_ASSET_SIZE ? "File too large" : "Unsupported asset type",
          details: uploadFileResult.issues,
        },
        file.size > MAX_ASSET_SIZE ? 413 : 400,
      );
    }

    const rawExt = file.name.includes(".")
      ? file.name.split(".").pop()!.toLowerCase()
      : "";
    const ext = /^[a-z0-9]+$/.test(rawExt) ? `.${rawExt}` : "";
    const key = `${crypto.randomUUID()}${ext}`;

    await c.env.ASSETS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });
    try {
      await upsertDocumentAssetRefs(c.env, userId, documentId, [key]);
    } catch (error) {
      // The upload is only usable once both R2 and document_assets agree on
      // the key. If the D1 write fails after the put, delete the object so we
      // do not strand an unreachable R2 blob.
      await c.env.ASSETS.delete(key);
      throw error;
    }
    scheduleDocumentAssetReconciliation(c, documentId);

    return c.json({ key });
  });

  app.get("/api/assets/:key", async (c) => {
    const userId = c.get("userId");
    const key = c.req.param("key");
    if (!isManagedAssetKey(key)) {
      return c.json({ error: "Not found" }, 404);
    }

    const assetRef = await c.env.DB.prepare(
      "SELECT 1 FROM document_assets WHERE asset_key = ? AND user_id = ? LIMIT 1",
    )
      .bind(key, userId)
      .first();
    if (!assetRef) {
      return c.json({ error: "Not found" }, 404);
    }

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
          return new Response("Range Not Satisfiable", { status: 416 });
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
    // Video playback and seeking commonly use byte ranges. Forward the incoming
    // Range header to R2 so browsers can stream instead of restarting at byte 0.
    const headers = buildAssetHeaders(contentType, object.size, object.range);
    const status = rangeHeader && object.range ? 206 : 200;

    return new Response(object.body, { status, headers });
  });
}
