import * as v from "valibot";

// Document title bounds: long enough to be useful, short enough to keep
// rows compact in D1. Reject null bytes — D1's TEXT column tolerates
// them but they break grep, leak through raw logs, and have no place in
// a user-facing label.
const DOCUMENT_TITLE_MAX_LENGTH = 256;

// Order is stored as REAL in D1 for fractional reordering. Bound it to
// a sane range so a malicious or confused client cannot push values that
// would clutter the sidebar's display formatter (and reject NaN /
// Infinity which JSON would otherwise pass through as `null`).
const DOCUMENT_ORDER_MIN = -1e9;
const DOCUMENT_ORDER_MAX = 1e9;

// Maximum snapshot push body size. tldraw snapshots are usually well
// under 1 MB; even the largest realistic doc with embedded references
// rarely exceeds a few MB. 5 MB gives plenty of headroom while
// preventing a runaway client from streaming arbitrary blobs at the DO.
export const MAX_SNAPSHOT_BODY_BYTES = 5 * 1024 * 1024;

const finiteNumber = v.pipe(v.number(), v.finite());

const nonNegativeFiniteInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
);

// Title: bounded length and no null bytes. Whitespace-only strings are
// allowed by valibot here; the client commits "Untitled" for empty
// titles in createNewDocument, so an explicit minLength would just push
// edge-case behavior to the request layer.
const documentTitleSchema = v.pipe(
  v.string(),
  v.maxLength(DOCUMENT_TITLE_MAX_LENGTH),
  v.regex(/^[^\u0000]*$/u, "Title contains a null byte"),
);

const documentOrderSchema = v.pipe(
  finiteNumber,
  v.minValue(DOCUMENT_ORDER_MIN),
  v.maxValue(DOCUMENT_ORDER_MAX),
);

export const documentIdParamSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
});

export const documentConnectParamSchema = v.object({
  documentId: v.pipe(v.string(), v.uuid()),
});

export const documentMetadataSchema = v.object({
  title: documentTitleSchema,
  order: documentOrderSchema,
  created_at: nonNegativeFiniteInteger,
  updated_at: nonNegativeFiniteInteger,
});

export const snapshotPushBodySchema = v.object({
  snapshot: v.record(v.string(), v.unknown()),
  expectedSnapshotVersion: nonNegativeFiniteInteger,
});
