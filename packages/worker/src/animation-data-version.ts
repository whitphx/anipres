import { ANIMATION_DATA_FORMAT_VERSION } from "anipres/models";

export const MINIMUM_SYNC_ANIMATION_DATA_VERSION =
  ANIMATION_DATA_FORMAT_VERSION;

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
