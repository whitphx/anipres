import { Hono } from "hono";
import * as v from "valibot";
import {
  assetNameSchema,
  documentAssetUploadFieldsSchema,
  documentAssetUploadFileSchema,
  documentIdParamSchema,
} from "../schemas";
import { MAX_ASSET_SIZE } from "../tldraw-asset-policy";
import {
  buildAssetHeaders,
  buildUnsatisfiableRangeHeaders,
  documentExistsForUser,
  getAssetExtensionForContentType,
  getDeclaredContentLength,
  getDocumentAssetKey,
  getDocumentAssetSrc,
  insertDocumentAsset,
  InvalidMultipartFormDataError,
  isSupportedAssetContentType,
  MAX_ASSET_REQUEST_BODY_SIZE,
  parseAssetUploadFormData,
  parseRangeHeader,
  RequestBodyTooLargeError,
  scheduleDocumentAssetGc,
} from "../tldraw-assets";
import type { AppBindings } from "../types";

// Chained Hono sub-router for the per-document asset endpoints.
// `typeof assetRoutes` flows into the worker's combined `AppType` so
// the app's typed client can call `apiClient.api.documents[
// ":id"].assets.$post({...})`. The asset GET returns raw bytes (an
// untyped `Response`) since browsers consume the asset URL directly
// via `<img>` etc.; including it in the chain keeps the type story
// uniform without losing anything.
//
// The R2 / multipart / range-request helpers this file uses
// (`parseAssetUploadFormData`, `parseRangeHeader`, etc.) live in
// `../tldraw-assets.ts` next to the asset GC and lifecycle code that
// shares them. Routes/ stays "just routes."
export const assetRoutes = new Hono<AppBindings>()
  .post("/api/documents/:id/assets", async (c) => {
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

    return c.json(
      {
        assetName,
        src: getDocumentAssetSrc(documentId, assetName),
      },
      200,
    );
  })
  .get("/api/documents/:id/assets/:assetName", async (c) => {
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

export type AssetRoutes = typeof assetRoutes;
