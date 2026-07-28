import { TIMELINE_FORMAT_VERSION } from "anipres/models";

/**
 * The server-enforced animation-data version gate
 * (docs/design-animation-data-model.md, Risk 6).
 *
 * Mixed-format tolerance in the anipres library covers migration and
 * crash recovery only — it is NOT bidirectional editing compatibility. A
 * v1-era client writing to a v2-edited document converges
 * deterministically but can silently revert newer ordering, so stale
 * clients must be excluded from sync writes entirely. tldraw's store
 * schema versioning does not cover `meta` contents, hence this explicit
 * gate.
 *
 * Single source of truth: derived from the library's
 * TIMELINE_FORMAT_VERSION (the format this build reads and writes).
 */
export const MINIMUM_SYNC_ANIMATION_DATA_VERSION: number =
  TIMELINE_FORMAT_VERSION;

/**
 * Returns an HTTP 426 response when the request does not declare a
 * sufficient animation-data version (via the `animationDataVersion` query
 * param or the `x-anipres-animation-data-version` header), or undefined
 * when the request may proceed. v1 clients send neither, so they are
 * rejected.
 */
export function getAnimationDataVersionGateResponse(
  request: Request,
): Response | undefined {
  const rawVersion =
    new URL(request.url).searchParams.get("animationDataVersion") ??
    request.headers.get("x-anipres-animation-data-version");
  const version = rawVersion === null ? NaN : Number(rawVersion);
  if (
    Number.isSafeInteger(version) &&
    version >= MINIMUM_SYNC_ANIMATION_DATA_VERSION
  ) {
    return undefined;
  }
  return Response.json(
    {
      error: "Animation data upgrade required",
      minimumVersion: MINIMUM_SYNC_ANIMATION_DATA_VERSION,
    },
    { status: 426 },
  );
}
