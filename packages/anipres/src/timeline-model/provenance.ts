// Copy-source provenance — the authoritative duplicate/external-paste
// classifier.
//
// Shape-id or animation-id collisions CANNOT classify a paste: two
// documents created from the same snapshot share every id, so a paste
// between them looks exactly like a local copy. Instead, the copy side
// stamps the content with an opaque token identifying the SOURCE editor
// instance, and the paste side compares it with its own token.
//
// Serialization contract (verified against the pinned tldraw version):
// the provenance is an extra top-level property on the `TLContent`
// object. tldraw's clipboard write spreads the content's non-asset
// properties into a JSON payload (`const { assets, ...otherData } =
// content`), and the paste path reconstructs `{ assets, ...otherData }`
// and hands the object to `putContentOntoCurrentPage` unchanged — so the
// property survives the real system-clipboard round trip (it is not an
// in-memory side channel). The paste interception strips it before
// insertion, so it is never persisted as document data; foreign
// consumers of the clipboard payload simply ignore the unknown key.
//
// Intended semantics per flow:
// - Same-document copy → paste: tokens match → "duplicate".
// - Paste from another document — even one with identical shape, frame,
//   step, and track ids (identical-snapshot siblings): tokens differ →
//   "external-paste".
// - Content without provenance (older anipres, hand-crafted payloads):
//   → "external-paste" (the safe default).
// - Cut → paste: tldraw's cut copies content (stamping the token) and
//   then deletes the shapes, so a same-document cut+paste classifies as
//   "duplicate". The remap freshens the copied identities; because the
//   originals were deleted, the placement pass finds no original steps
//   and keeps the source keys, so frames come back at their old
//   positions with fresh identities. A cross-document cut+paste has
//   differing tokens → "external-paste", which keeps identities — the
//   wanted move semantics.
// - Same document remounted between copy and paste (reload, reopen):
//   the token is per mounted editor instance, so this classifies as
//   "external-paste"; colliding ids are then freshened by the remap —
//   conservative, never data-corrupting.

import type { RemapOperation } from "./duplicate";

export interface AnipresCopyProvenance {
  /** Opaque token of the editor instance the content was copied from. */
  sourceDocumentToken: string;
}

/** Property name carrying the provenance on a `TLContent` object. */
export const COPY_PROVENANCE_KEY = "anipresCopyProvenance";

/** Stamps content (a `TLContent`-shaped object) with copy provenance. */
export function attachCopyProvenance<T extends object>(
  content: T,
  sourceDocumentToken: string,
): T {
  return {
    ...content,
    [COPY_PROVENANCE_KEY]: { sourceDocumentToken },
  };
}

/** Reads the provenance off pasted content; null if absent or malformed. */
export function readCopyProvenance(
  content: object | null | undefined,
): AnipresCopyProvenance | null {
  if (content == null) {
    return null;
  }
  const value = (content as Record<string, unknown>)[COPY_PROVENANCE_KEY];
  if (
    typeof value === "object" &&
    value != null &&
    typeof (value as Record<string, unknown>).sourceDocumentToken === "string"
  ) {
    return {
      sourceDocumentToken: (value as AnipresCopyProvenance).sourceDocumentToken,
    };
  }
  return null;
}

/**
 * Removes the provenance property so it is never persisted as document
 * data. Returns the same reference when the property is absent.
 */
export function stripCopyProvenance<T extends object>(content: T): T {
  if (!(COPY_PROVENANCE_KEY in content)) {
    return content;
  }
  const copy = { ...content } as Record<string, unknown>;
  delete copy[COPY_PROVENANCE_KEY];
  return copy as T;
}

/**
 * Classifies a content-insertion operation from copy provenance:
 * a matching token means within-document duplication; a different or
 * absent token means external paste. Never classifies by shape-id or
 * animation-id collisions (see the module comment for why they cannot
 * distinguish identical-snapshot documents).
 */
export function classifyRemapOperation(input: {
  provenance: AnipresCopyProvenance | null;
  localDocumentToken: string;
}): RemapOperation {
  return input.provenance?.sourceDocumentToken === input.localDocumentToken
    ? "duplicate"
    : "external-paste";
}
