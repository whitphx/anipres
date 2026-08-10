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
// Operation meanings (see `RemapOperation`):
//   duplicate      = create a new independent copy
//   move           = restore the same logical animation objects after cut
//   external-paste = import content from another document
//
// Classification combines the token with SOURCE-SHAPE existence — the
// token alone cannot tell copy/paste from cut/paste (tldraw's cut stamps
// the content at copy time and then deletes the shapes), and treating a
// cut as a duplication would freshen stepId/trackId and break the
// relationships of partially cut steps, tracks, and batches:
// - Token matches and EVERY source shape still exists → "duplicate"
//   (plain copy/paste — and also cut, undo-cut, paste: the restored
//   originals own their identities again, so the paste must be an
//   independent copy, never a rejoin).
// - Token matches and NO source shape exists → "move" (cut → paste; the
//   same logical objects return and rejoin uncut members of their
//   steps/tracks/batches).
// - Token matches with MIXED presence (partial undo/deletion between cut
//   and paste) → "external-paste", the conservative default: neither
//   duplication (would freshen and mis-place against half-restored
//   originals) nor move (could rejoin records whose ownership is
//   ambiguous) is safe to apply partially; collision-driven remapping
//   never corrupts.
// - Token differs or is absent (other documents — even identical-
//   snapshot siblings sharing every id — older anipres, hand-crafted
//   payloads, a remounted instance) → "external-paste".
// - Empty content → "external-paste" (nothing to classify; a no-op).

import type { RemapOperation } from "./duplicate";

export interface AnipresCopyProvenance {
  /** Opaque token of the editor instance the content was copied from. */
  sourceDocumentToken: string;
  /**
   * The shapes the copy actually asked for, before anything was added
   * to the payload on their behalf. Copying a video pulls in its
   * invisible event markers, and a cut deletes only what was selected —
   * so the markers outlive the carrier, and reading presence off the
   * payload would see one id gone and another still there and call an
   * ordinary cut and paste an import from somewhere else.
   *
   * Absent on a payload from a build that predates this, where the
   * classification falls back to the payload's own ids.
   */
  requestedShapeIds?: readonly string[];
}

/** Property name carrying the provenance on a `TLContent` object. */
export const COPY_PROVENANCE_KEY = "anipresCopyProvenance";

/** Stamps content (a `TLContent`-shaped object) with copy provenance. */
export function attachCopyProvenance<T extends object>(
  content: T,
  sourceDocumentToken: string,
  requestedShapeIds?: readonly string[],
): T {
  return {
    ...content,
    [COPY_PROVENANCE_KEY]: { sourceDocumentToken, requestedShapeIds },
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
    const requestedShapeIds = (value as Record<string, unknown>)
      .requestedShapeIds;
    return {
      sourceDocumentToken: (value as AnipresCopyProvenance).sourceDocumentToken,
      ...(Array.isArray(requestedShapeIds) &&
      requestedShapeIds.every((id) => typeof id === "string")
        ? { requestedShapeIds: requestedShapeIds as string[] }
        : {}),
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
 * Classifies a content-insertion operation from copy provenance plus
 * source-shape existence (full rules and rationale: module comment).
 * Never classifies by shape-id or animation-id COLLISIONS — those cannot
 * distinguish identical-snapshot documents; source-shape existence is
 * only consulted once the token has proven the content local.
 */
export function classifyRemapOperation(input: {
  provenance: AnipresCopyProvenance | null;
  localDocumentToken: string;
  /** Shape ids carried by the inserted content (= the SOURCE shape ids). */
  sourceShapeIds: readonly string[];
  /** Whether a shape id currently resolves in the destination document. */
  shapeExistsInDocument: (shapeId: string) => boolean;
}): RemapOperation {
  const { provenance, localDocumentToken, sourceShapeIds } = input;
  if (provenance?.sourceDocumentToken !== localDocumentToken) {
    return "external-paste";
  }
  // What the copy asked for, not what the payload ended up carrying:
  // anything added on the caller's behalf has its own lifetime and
  // would otherwise read as mixed presence.
  const requested =
    provenance.requestedShapeIds != null &&
    provenance.requestedShapeIds.length > 0
      ? provenance.requestedShapeIds
      : sourceShapeIds;
  if (requested.length === 0) {
    return "external-paste";
  }
  const existing = requested.filter((shapeId) =>
    input.shapeExistsInDocument(shapeId),
  ).length;
  if (existing === requested.length) {
    return "duplicate";
  }
  if (existing === 0) {
    return "move";
  }
  // Mixed presence: conservative fallback (see module comment).
  return "external-paste";
}
