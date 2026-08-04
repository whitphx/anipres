import { TIMELINE_FORMAT_VERSION } from "anipres/models";

/**
 * The server-enforced animation-data version gate
 * (docs/design-animation-data-model.md, Risk 6).
 *
 * A v1-era client writing to a v2 document would silently revert newer
 * ordering, and the library no longer converts v1 output — it only
 * recognizes it, as a diagnostic — so stale clients must be excluded
 * from sync writes entirely.
 * tldraw's store schema versioning does not cover `meta` contents,
 * hence this explicit gate (rationale: TIMELINE_FORMAT_VERSION's
 * docstring in anipres).
 *
 * Single source of truth: derived from the library's
 * TIMELINE_FORMAT_VERSION (the format this build reads and writes).
 */
export const MINIMUM_SYNC_ANIMATION_DATA_VERSION: number =
  TIMELINE_FORMAT_VERSION;

/**
 * Whether the request declares a sufficient animation-data version (via
 * the `animationDataVersion` query param or the
 * `x-anipres-animation-data-version` header). v1 clients send neither.
 */
export function isAnimationDataVersionAllowed(request: Request): boolean {
  const rawVersion =
    new URL(request.url).searchParams.get("animationDataVersion") ??
    request.headers.get("x-anipres-animation-data-version");
  const version = rawVersion === null ? NaN : Number(rawVersion);
  return (
    Number.isSafeInteger(version) &&
    version >= MINIMUM_SYNC_ANIMATION_DATA_VERSION
  );
}

/**
 * Returns an HTTP 426 response when the request fails the version check,
 * or undefined when it may proceed. For plain HTTP endpoints (snapshot
 * push) only — a WebSocket upgrade must be rejected in-protocol instead
 * (see `getSyncAnimationDataVersionGateResponse`): an HTTP status
 * returned before the upgrade surfaces to the client as an opaque
 * close code 1006, indistinguishable from a network failure.
 */
export function getAnimationDataVersionGateResponse(
  request: Request,
): Response | undefined {
  if (isAnimationDataVersionAllowed(request)) {
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
