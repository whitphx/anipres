import * as v from "valibot";
import { MAX_ASSET_SIZE } from "./asset-policy.ts";

// Document title bounds: long enough to be useful, short enough to keep
// rows compact in D1. Reject null bytes — D1's TEXT column tolerates
// them but they break grep, leak through raw logs, and have no place in
// a user-facing label.
const DOCUMENT_TITLE_MAX_LENGTH = 256;

// Sort-order is a fractional-indexing key. The package emits printable-
// ASCII strings; this bound is a sanity cap to reject pathological
// inputs. Real keys are typically <20 chars even after many reorders.
const SORT_ORDER_MAX_LENGTH = 256;

// Maximum snapshot push body size. tldraw snapshots are usually well
// under 1 MB; even the largest realistic doc with embedded references
// rarely exceeds a few MB. 5 MB gives plenty of headroom while
// preventing a runaway client from streaming arbitrary blobs at the DO.
export const MAX_SNAPSHOT_BODY_BYTES = 5 * 1024 * 1024;

const nonNegativeFiniteInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
);

// Title: at least one non-whitespace character, bounded length, no null
// bytes. Empty / whitespace-only titles would render as a blank sidebar
// row; the client commits "Untitled" for missing titles in
// createNewDocument, so this guard is the server-side floor for any
// caller that bypasses that path.
const documentTitleSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.regex(/\S/u, "Title cannot be only whitespace"),
  v.maxLength(DOCUMENT_TITLE_MAX_LENGTH),
  v.regex(/^[^\u0000]*$/u, "Title contains a null byte"),
);

const sortOrderSchema = v.pipe(
  v.string(),
  v.minLength(1, "sort_order cannot be empty"),
  v.maxLength(SORT_ORDER_MAX_LENGTH, "sort_order too long"),
);

// Document ids are client-allocated UUIDs (v7, see
// `0001_initial_schema.sql`'s design note on the documents table).
// Validate the canonical 36-char hex-with-dashes form here so a
// malformed id never reaches the D1 layer; the schema's CHECK
// constraint is the second line of defense.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const documentIdSchema = v.pipe(
  v.string(),
  v.regex(UUID_PATTERN, "Invalid document id"),
);

// Workspace ids are server-allocated INTEGER autoincrement values;
// clients pass them as decimal strings (URL params, query strings,
// JSON body fields). Coerce to a JS number after validation so
// handlers can pass it straight to D1 `.bind()` (which is happy with
// either type for INTEGER columns). Reject leading zeros to keep the
// wire form canonical.
//
// Note: the asymmetry with `documents.id` is deliberate. Workspaces
// are a server-side concept the user never originates offline, so the
// INTEGER rowid wins (smaller indexes, sequential inserts) without
// the migration friction. Documents flip the trade-off because the
// id needs to flow unchanged through the local → synced path.
const workspaceIdSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/u, "Invalid workspace id"),
  v.transform(Number),
);

export const documentIdParamSchema = v.object({
  id: documentIdSchema,
});

export const documentConnectParamSchema = v.object({
  documentId: documentIdSchema,
});

// Query string for GET /api/documents — workspace-scoped list.
// `workspace_id` is required: every list call has to name the
// workspace it's listing. Phase 1 has 1:1 user:workspace, so the
// client always passes its own; Extension A will let it list any
// workspace it's a member of.
export const documentListQuerySchema = v.object({
  workspace_id: workspaceIdSchema,
});

// Body for PUT /api/documents/:id — a single upsert endpoint that
// covers both create (when no row with this id exists) and update
// (when one does). The wire shape is uniform so the client doesn't
// have to track which case it's in:
//
// - `workspace_id` is always required. On insert the server places
//   the row in this workspace; on update the server validates the
//   existing row is in this workspace (rejects cross-workspace moves
//   as 404). Idempotent: replaying the same body is a no-op on the
//   second call.
// - `title` and `sort_order` are always required — the body
//   describes the post-state, so the client sends the current
//   values even on a re-save.
// - `created_at` is an optional override used only on insert (the
//   local→synced migration uses it to preserve the on-device creation
//   time). The server ignores it on update; `updated_at` is always
//   server-stamped via the documents.updated_at trigger.
//
// `id` lives in the URL path, not the body — see
// `documentIdParamSchema`.
export const documentUpsertSchema = v.object({
  workspace_id: workspaceIdSchema,
  title: documentTitleSchema,
  sort_order: sortOrderSchema,
  created_at: v.optional(nonNegativeFiniteInteger),
});

export const snapshotPushBodySchema = v.object({
  snapshot: v.record(v.string(), v.unknown()),
  expectedSnapshotVersion: nonNegativeFiniteInteger,
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
export const ASSET_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[a-z0-9]+)?$/i;

export const documentAssetUploadFieldsSchema = v.object({
  file: v.file("Missing file field"),
});

export const documentAssetUploadFileSchema = v.pipe(
  v.file(),
  v.mimeType(SUPPORTED_ASSET_CONTENT_TYPES),
  v.maxSize(MAX_ASSET_SIZE),
);

export const assetNameSchema = v.pipe(
  v.string(),
  v.regex(ASSET_NAME_PATTERN, "Invalid asset name"),
);

// URL-param schema for `DELETE /auth/identities/:provider/:provider_id`.
// `provider` is closed-set — only the providers we register OAuth flows
// for can land in `oauth_identities`, so the API surface stays
// constrained to the same set. `provider_id` comes from the upstream
// IdP (numeric for GitHub, opaque `sub` for Google); we don't enforce
// a specific format, just non-empty + bounded length so a pathological
// client can't smuggle an unbounded string into a parameterized
// statement.
export const oauthIdentityRevokeParamSchema = v.object({
  provider: v.picklist(["github", "google"]),
  provider_id: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
