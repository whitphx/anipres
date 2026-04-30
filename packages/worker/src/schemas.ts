import * as v from "valibot";

// Single-route schemas live next to their handlers in `./routes/*.ts`
// so a reader of a route file sees its wire shape without jumping
// files. This module is for schemas used across multiple route
// files.

// Document ids are client-allocated UUIDs (v7, see
// `0001_initial_schema.sql`'s design note on the documents table).
// Validate the canonical 36-char hex-with-dashes form here so a
// malformed id never reaches the D1 layer; the schema's CHECK
// constraint is the second line of defense.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const documentIdSchema = v.pipe(
  v.string(),
  v.regex(UUID_PATTERN, "Invalid document id"),
);

export const documentIdParamSchema = v.object({
  id: documentIdSchema,
});

// Server-side allowlist of asset content types. Mirror tldraw's defaults
// for image and short-form video formats; SVG is included for vector
// imports. Anything outside the list is rejected by the upload handler
// before R2 ever sees the bytes.
export const SUPPORTED_ASSET_CONTENT_TYPES = [
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

// Asset names are server-generated as `<UUIDv1-5>.<extension?>` — the
// extension is derived from the validated MIME type, not the upload
// filename. This pattern is what we accept on the read path so a
// pathological client cannot escape into other R2 prefixes.
const ASSET_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;

export const assetNameSchema = v.pipe(
  v.string(),
  v.regex(ASSET_NAME_PATTERN, "Invalid asset name"),
);
