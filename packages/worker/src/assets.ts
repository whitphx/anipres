import type { Hono } from "hono";
import type { AppBindings, AppContext, Env } from "./types";

const SUPPORTED_ASSET_CONTENT_TYPES = new Set([
  // Images (matches tldraw DEFAULT_SUPPORTED_IMAGE_TYPES)
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/apng",
  "image/avif",
  "image/svg+xml",
  // Videos (matches tldraw DEFAULT_SUPPORT_VIDEO_TYPES)
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB

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

function isSupportedAssetContentType(contentType: string) {
  return SUPPORTED_ASSET_CONTENT_TYPES.has(contentType);
}

function isSvgContentType(contentType: string) {
  return contentType === "image/svg+xml";
}

function isManagedAssetKey(key: string) {
  return MANAGED_ASSET_KEY_PATTERN.test(key);
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

async function getDocumentAssetKeys(
  env: AssetEnv,
  userId: number,
  documentId: string,
) {
  const { results } = await env.DB.prepare(
    "SELECT asset_key FROM document_assets WHERE document_id = ? AND user_id = ?",
  )
    .bind(documentId, userId)
    .all<AssetKeyRow>();
  return results.map((row) => row.asset_key);
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

  await env.ASSETS.delete(orphanedKeys);
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

  const offset = range.offset ?? 0;
  const length = range.length ?? size - offset;
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

export async function deleteDocumentAssetsForDocument(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  const assetKeys = await getDocumentAssetKeys(c.env, userId, documentId);
  await c.env.DB.prepare(
    "DELETE FROM document_assets WHERE document_id = ? AND user_id = ?",
  )
    .bind(documentId, userId)
    .run();
  await deleteUnreferencedAssets(c.env, assetKeys);
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

export function registerAssetRoutes(app: Hono<AppBindings>) {
  app.post("/api/assets", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.parseBody();
    const file = body["file"];
    const documentId = body["documentId"];

    if (!(file instanceof File)) {
      return c.json({ error: "Missing file field" }, 400);
    }
    if (typeof documentId !== "string") {
      return c.json({ error: "Missing documentId field" }, 400);
    }
    if (!(await documentExistsForUser(c, userId, documentId))) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!isSupportedAssetContentType(file.type)) {
      return c.json({ error: "Unsupported asset type" }, 400);
    }
    if (file.size > MAX_ASSET_SIZE) {
      return c.json({ error: "File too large" }, 413);
    }

    const rawExt = file.name.includes(".")
      ? file.name.split(".").pop()!.toLowerCase()
      : "";
    const ext = /^[a-z0-9]+$/.test(rawExt) ? `.${rawExt}` : "";
    const key = `${crypto.randomUUID()}${ext}`;

    await c.env.ASSETS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });
    await upsertDocumentAssetRefs(c.env, userId, documentId, [key]);
    await notifyDocumentAssetReconciliation(c, documentId);

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
    const object = rangeHeader
      ? await c.env.ASSETS.get(key, { range: c.req.raw.headers })
      : await c.env.ASSETS.get(key);
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
