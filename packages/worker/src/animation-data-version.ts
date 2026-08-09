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
 * A client AHEAD of this build is excluded by the same constant: it
 * would write records this build has no registration for. See
 * `getAnimationDataVersionRejection`.
 *
 * Single source of truth: the library's SYNC_CLIENT_VERSION, whose
 * docstring carries the per-version history.
 */
export const REQUIRED_SYNC_ANIMATION_DATA_VERSION: number = SYNC_CLIENT_VERSION;

/** Why a request failed the gate, or null when it passed. */
export type AnimationDataVersionRejection = "client-too-old" | "server-too-old";

/**
 * The declared version (via the `animationDataVersion` query param or
 * the `x-anipres-animation-data-version` header; v1 clients send
 * neither) checked against the one vocabulary this build knows.
 *
 * Both directions are fatal, which is why this is an equality check
 * rather than a floor. A client below it cannot read the records the
 * document may already hold. A client ABOVE it writes records this
 * build has no schema registration for, so the room would reject them
 * on save — the failure mode the deploy order exists to avoid, and one
 * the client cannot detect for itself.
 */
export function getAnimationDataVersionRejection(
  request: Request,
): AnimationDataVersionRejection | null {
  const rawVersion =
    new URL(request.url).searchParams.get("animationDataVersion") ??
    request.headers.get("x-anipres-animation-data-version");
  const version = rawVersion === null ? NaN : Number(rawVersion);
  if (!Number.isSafeInteger(version)) {
    return "client-too-old";
  }
  if (version < REQUIRED_SYNC_ANIMATION_DATA_VERSION) {
    return "client-too-old";
  }
  if (version > REQUIRED_SYNC_ANIMATION_DATA_VERSION) {
    return "server-too-old";
  }
  return null;
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
  const rejection = getAnimationDataVersionRejection(request);
  if (rejection === null) {
    return undefined;
  }
  return Response.json(
    {
      error:
        rejection === "client-too-old"
          ? "Animation data upgrade required"
          : "Server animation data upgrade required",
      // The direction, for a caller that has to choose between telling
      // the user to reload and telling them to wait.
      reason: rejection,
      // `minimumVersion` since the gate shipped with that name; both
      // bounds are this one value.
      minimumVersion: REQUIRED_SYNC_ANIMATION_DATA_VERSION,
    },
    { status: 426 },
  );
}
