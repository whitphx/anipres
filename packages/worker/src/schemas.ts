import * as v from "valibot";

// Reject malformed document ids at the wire boundary so they never
// reach D1 (the table's own CHECK constraint is the second line of
// defense).
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const documentIdSchema = v.pipe(
  v.string(),
  v.regex(UUID_PATTERN, "Invalid document id"),
);

export const documentIdParamSchema = v.object({
  id: documentIdSchema,
});

// Allowlist for asset uploads: anything outside the list is rejected
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

// Asset extensions are derived server-side from the validated MIME
// type, not the upload filename. Enforcing the pattern on the read
// path keeps a pathological client from escaping into other R2
// prefixes.
const ASSET_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;

export const assetNameSchema = v.pipe(
  v.string(),
  v.regex(ASSET_NAME_PATTERN, "Invalid asset name"),
);
