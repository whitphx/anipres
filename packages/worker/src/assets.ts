import type { Hono } from "hono";
import { file, maxSize, mimeType, object, pipe, string, uuid } from "valibot";
import type { AppBindings, AppContext, Env } from "./types";
import { validateWithSchema } from "./validation";

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

const DOCUMENT_ASSET_PREFIX = "documents";
const ASSET_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;
const DOCUMENT_ASSET_PATH_PATTERN =
  /^\/api\/documents\/([0-9a-f-]{36})\/assets\/([^/]+)$/i;

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

const documentAssetUploadFieldsSchema = object({
  file: file("Missing file field"),
});

const documentAssetUploadFileSchema = pipe(
  file(),
  mimeType(SUPPORTED_ASSET_CONTENT_TYPES),
  maxSize(MAX_ASSET_SIZE),
);

const documentIdParamSchema = object({
  id: pipe(string(), uuid()),
});

type AssetCloneRequest = {
  src: string;
};

function isSvgContentType(contentType: string) {
  return contentType === "image/svg+xml";
}

function isManagedAssetName(assetName: string) {
  return ASSET_NAME_PATTERN.test(assetName);
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

function parseManagedDocumentAssetSrc(src: string) {
  try {
    const url = new URL(src, "https://anipres.invalid");
    const match = url.pathname.match(DOCUMENT_ASSET_PATH_PATTERN);
    if (!match) {
      return null;
    }

    const [, documentId, encodedAssetName] = match;
    const assetName = decodeURIComponent(encodedAssetName);
    if (!isManagedAssetName(assetName)) {
      return null;
    }

    return { documentId, assetName };
  } catch {
    return null;
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

type R2RangeLike = R2Range | undefined;

function normalizeRange(
  size: number,
  range?: R2RangeLike,
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

function buildAssetHeaders(contentType: string, size: number, range?: R2RangeLike) {
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

async function cloneDocumentAsset(
  env: Pick<Env, "ASSETS">,
  sourceDocumentId: string,
  sourceAssetName: string,
  targetDocumentId: string,
) {
  const sourceKey = getDocumentAssetKey(sourceDocumentId, sourceAssetName);
  const sourceObject = await env.ASSETS.get(sourceKey);
  if (!sourceObject) {
    return null;
  }

  const rawExt = sourceAssetName.includes(".")
    ? sourceAssetName.split(".").pop()!.toLowerCase()
    : "";
  const ext = /^[a-z0-9]+$/.test(rawExt) ? `.${rawExt}` : "";
  const targetAssetName = `${crypto.randomUUID()}${ext}`;
  const targetKey = getDocumentAssetKey(targetDocumentId, targetAssetName);

  await env.ASSETS.put(targetKey, sourceObject.body, {
    httpMetadata: sourceObject.httpMetadata,
  });

  return {
    assetName: targetAssetName,
    src: getDocumentAssetSrc(targetDocumentId, targetAssetName),
  };
}

export async function deleteDocumentAndAssets(
  c: AppContext,
  userId: number,
  documentId: string,
) {
  const { meta } = await c.env.DB.prepare(
    "DELETE FROM documents WHERE id = ? AND user_id = ?",
  )
    .bind(documentId, userId)
    .run();

  if (meta.changes > 0) {
    try {
      await deleteDocumentAssetPrefix(c.env.ASSETS, documentId);
    } catch (error) {
      console.error("Failed to delete document asset prefix", error);
    }
  }
}

export function registerAssetRoutes(app: Hono<AppBindings>) {
  app.post("/api/documents/:id/assets", async (c) => {
    const userId = c.get("userId");
    const paramsResult = validateWithSchema(documentIdParamSchema, {
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

    const uploadFieldsResult = validateWithSchema(documentAssetUploadFieldsSchema, {
      file: formData.get("file"),
    });
    if (!uploadFieldsResult.success) {
      return c.json(
        { error: "Invalid asset upload fields", details: uploadFieldsResult.issues },
        400,
      );
    }

    const { file: uploadFile } = uploadFieldsResult.output;
    const uploadFileResult = validateWithSchema(
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

    await c.env.ASSETS.put(key, uploadFile.stream(), {
      httpMetadata: { contentType: uploadFile.type },
    });

    return c.json({
      assetName,
      src: getDocumentAssetSrc(documentId, assetName),
    });
  });

  app.post("/api/documents/:id/assets/clone", async (c) => {
    const userId = c.get("userId");
    const paramsResult = validateWithSchema(documentIdParamSchema, {
      id: c.req.param("id"),
    });
    if (!paramsResult.success) {
      return c.json(
        { error: "Invalid document id", details: paramsResult.issues },
        400,
      );
    }

    const { id: targetDocumentId } = paramsResult.output;
    if (!(await documentExistsForUser(c, userId, targetDocumentId))) {
      return c.json({ error: "Not found" }, 404);
    }

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const request = json as Partial<AssetCloneRequest>;
    if (typeof request.src !== "string") {
      return c.json({ error: "Missing src" }, 400);
    }

    const source = parseManagedDocumentAssetSrc(request.src);
    if (!source) {
      return c.json({ error: "Invalid asset src" }, 400);
    }
    if (!(await documentExistsForUser(c, userId, source.documentId))) {
      return c.json({ error: "Not found" }, 404);
    }

    const clone = await cloneDocumentAsset(
      c.env,
      source.documentId,
      source.assetName,
      targetDocumentId,
    );
    if (!clone) {
      return c.json({ error: "Not found" }, 404);
    }

    return c.json(clone);
  });

  app.get("/api/documents/:id/assets/:assetName", async (c) => {
    const userId = c.get("userId");
    const paramsResult = validateWithSchema(documentIdParamSchema, {
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
    if (!isManagedAssetName(assetName)) {
      return c.json({ error: "Not found" }, 404);
    }

    const key = getDocumentAssetKey(documentId, assetName);
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
