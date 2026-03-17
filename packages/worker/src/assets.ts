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

type AssetEnv = Pick<Env, "ASSETS" | "DB">;

const MANAGED_ASSET_PATH_PREFIX = "/api/assets/";
const MANAGED_ASSET_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;

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

async function insertDocumentAssetRefs(
  env: AssetEnv,
  userId: number,
  documentId: string,
  assetKeys: string[],
) {
  if (assetKeys.length === 0) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(
    assetKeys.map((assetKey) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO document_assets (document_id, asset_key, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(documentId, assetKey, userId, now),
    ),
  );
}

async function deleteDocumentAssetRefs(
  env: AssetEnv,
  userId: number,
  documentId: string,
  assetKeys: string[],
) {
  if (assetKeys.length === 0) {
    return;
  }

  await env.DB.batch(
    assetKeys.map((assetKey) =>
      env.DB.prepare(
        "DELETE FROM document_assets WHERE document_id = ? AND user_id = ? AND asset_key = ?",
      ).bind(documentId, userId, assetKey),
    ),
  );
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

function collectManagedAssetKeys(value: unknown, keys: Set<string>) {
  if (typeof value === "string") {
    const assetKey = getManagedAssetKeyFromSrc(value);
    if (assetKey) {
      keys.add(assetKey);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectManagedAssetKeys(item, keys));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  Object.values(value).forEach((item) => collectManagedAssetKeys(item, keys));
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

export function getManagedAssetKeysFromValue(value: unknown) {
  const keys = new Set<string>();
  collectManagedAssetKeys(value, keys);
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
  const currentKeys = await getDocumentAssetKeys(env, userId, documentId);

  const nextKeySet = new Set(nextKeys);
  const currentKeySet = new Set(currentKeys);
  const staleKeys = currentKeys.filter((key) => !nextKeySet.has(key));
  const addedKeys = nextKeys.filter((key) => !currentKeySet.has(key));

  // Persist document-to-asset refs so normal edits can release stale R2
  // objects instead of leaking storage forever.
  await insertDocumentAssetRefs(env, userId, documentId, addedKeys);
  await deleteDocumentAssetRefs(env, userId, documentId, staleKeys);
  await deleteUnreferencedAssets(env, staleKeys);
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
    await insertDocumentAssetRefs(c.env, userId, documentId, [key]);

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
