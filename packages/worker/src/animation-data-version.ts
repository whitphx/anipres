import { SYNC_CLIENT_VERSION } from "anipres/models";

/**
 * The server-enforced client version gate
 * (docs/design-animation-data-model.md, Risk 6).
 *
 * Stale clients must be excluded from sync writes entirely: a v1-era
 * client would silently revert newer ordering (the library only
 * recognizes v1 output, as a diagnostic), and a client predating a
 * record-vocabulary expansion fails the store load on the unknown
 * shape or binding, or parses the unknown frame action as an
 * `invalid-frame` whose offered repair clears it. tldraw's store schema
 * versioning covers neither, hence this explicit gate.
 *
 * Single source of truth: the library's SYNC_CLIENT_VERSION, whose
 * docstring carries the per-version history.
 */
export const MINIMUM_SYNC_ANIMATION_DATA_VERSION: number = SYNC_CLIENT_VERSION;

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
