import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import * as v from "valibot";
import {
  SUPPORTED_ASSET_CONTENT_TYPES,
  documentAssetParamSchema,
  documentAssetUploadFieldsSchema,
  documentAssetUploadFileSchema,
  documentIdParamSchema,
} from "../schemas";
import { MAX_ASSET_SIZE } from "../tldraw-asset-policy";
// `getDocumentAssetKey` is shared with the asset GC / lifecycle
// code — see `../tldraw-assets.ts`. The other helpers used here
// (multipart parsing, range-request math, content-type derivation,
// the per-doc DB existence check) are file-private below.
import { getDocumentAssetKey } from "../tldraw-assets";
import type { AppBindings, AppContext } from "../types";

// --- Content-type derivation -----------------------------------------

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

function getDocumentAssetSrc(documentId: string, assetName: string) {
  return `/api/documents/${encodeURIComponent(documentId)}/assets/${encodeURIComponent(assetName)}`;
}

// --- Multipart upload parsing ----------------------------------------

const MAX_ASSET_MULTIPART_OVERHEAD = 256 * 1024; // 256 KB
const MAX_ASSET_REQUEST_BODY_SIZE =
  MAX_ASSET_SIZE + MAX_ASSET_MULTIPART_OVERHEAD;

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

// --- Range-request math (GET /assets/:assetName) ---------------------

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

// --- DB existence check + asset row insert ---------------------------

async function documentExistsForUser(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  // Upload and asset-read paths only operate on active documents. Once a
  // delete starts, `deleting_at` closes the race where an in-flight upload
  // could otherwise recreate a blob after the delete sweep has already run.
  const document = await c.env.DB.prepare(
    `SELECT 1
     FROM documents
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
       AND deleting_at IS NULL`,
  )
    .bind(documentId, userId)
    .first();
  return Boolean(document);
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
    `INSERT INTO tldraw_assets (
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

async function scheduleDocumentAssetGc(
  c: AppContext,
  documentId: string,
): Promise<void> {
  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentId);
  await room.claimDocument(documentId);
  await room.scheduleAssetGc();
}

// --- Routes ----------------------------------------------------------

// Chained Hono sub-router for the per-document asset endpoints.
// `typeof assetRoutes` flows into the worker's combined `AppType` so
// the app's typed client can call `apiClient.api.documents[
// ":id"].assets.$post({...})`. The asset GET returns raw bytes (an
// untyped `Response`) since browsers consume the asset URL directly
// via `<img>` etc.; including it in the chain keeps the type story
// uniform without losing anything.
export const assetRoutes = new Hono<AppBindings>()
  .post(
    "/api/documents/:id/assets",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id: documentId } = c.req.valid("param");
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

      const uploadFieldsResult = v.safeParse(
        documentAssetUploadFieldsSchema,
        {
          file: formData.get("file"),
        },
      );
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

      // Derive the suffix from the validated MIME type instead of
      // trusting the uploaded filename. That keeps asset keys bounded
      // and predictable even if a client sends a pathological or
      // misleading name.
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
        await insertDocumentAsset(
          c.env,
          documentId,
          assetName,
          uploadFile.type,
        );
      } catch (error) {
        await c.env.ASSETS.delete(key);
        throw error;
      }

      c.executionCtx.waitUntil(
        scheduleDocumentAssetGc(c, documentId).catch((error) => {
          console.error("Failed to schedule document asset GC", error);
        }),
      );

      return c.json(
        {
          assetName,
          src: getDocumentAssetSrc(documentId, assetName),
        },
        200,
      );
    },
  )
  .get(
    "/api/documents/:id/assets/:assetName",
    // Both segments validated together via the combined schema.
    // Pre-typed-RPC the asset-name path returned 404 on a malformed
    // name (treating it as "no such asset"); preserve that by mapping
    // the validator's failure to 404 here too — a malformed name
    // can't address an asset, so "not found" is more accurate than
    // 400 for the route's external contract.
    vValidator("param", documentAssetParamSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "Not found" }, 404);
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id: documentId, assetName } = c.req.valid("param");
      if (!(await documentExistsForUser(c, userId, documentId))) {
        return c.json({ error: "Not found" }, 404);
      }

      const key = getDocumentAssetKey(documentId, assetName);
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
        object.httpMetadata?.contentType ??
        metadata?.httpMetadata?.contentType;
      if (!contentType || !isSupportedAssetContentType(contentType)) {
        return c.json({ error: "Not found" }, 404);
      }

      const headers = buildAssetHeaders(contentType, object.size, object.range);
      const status = rangeHeader && object.range ? 206 : 200;

      return new Response(object.body, { status, headers });
    },
  );

export type AssetRoutes = typeof assetRoutes;
