export interface ParsedYouTubeUrl {
  videoId: string;
  /** Start position in seconds when the URL carries one (t / start). */
  start: number | null;
}

// YouTube video ids are 11 chars of [A-Za-z0-9_-]. The length is not
// documented as a guarantee, so accept a small range around it.
const VIDEO_ID_RE = /^[\w-]{10,12}$/;

/**
 * Parses a "1h2m3s" / "90s" / plain-seconds time designator as used by
 * YouTube's `t` URL parameter.
 */
function parseTimeDesignator(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (
    match == null ||
    (match[1] == null && match[2] == null && match[3] == null)
  ) {
    return null;
  }
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

/**
 * Extracts the video id (and start time, if present) from the URL forms
 * YouTube serves: watch, youtu.be, shorts, live, embed — or a bare
 * video id. Returns null for anything else.
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (VIDEO_ID_RE.test(trimmed)) {
    return { videoId: trimmed, start: null };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");
  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const [, first, second] = url.pathname.split("/");
    if (first === "watch") {
      videoId = url.searchParams.get("v");
    } else if (first === "shorts" || first === "live" || first === "embed") {
      videoId = second ?? null;
    }
  }
  if (videoId == null || !VIDEO_ID_RE.test(videoId)) {
    return null;
  }

  const timeParam = url.searchParams.get("t") ?? url.searchParams.get("start");
  const start = timeParam != null ? parseTimeDesignator(timeParam) : null;
  return { videoId, start };
}

/**
 * Builds the privacy-enhanced embed URL with the JS API enabled so the
 * player accepts commands from `YouTubePlayerManager`.
 */
export function buildYouTubeEmbedUrl(options: {
  videoId: string;
  start: number;
  muted: boolean;
  controls: boolean;
  origin: string | null;
}): string {
  const { videoId, start, muted, controls, origin } = options;
  const url = new URL(
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`,
  );
  url.searchParams.set("enablejsapi", "1");
  url.searchParams.set("playsinline", "1");
  url.searchParams.set("rel", "0");
  if (start > 0) {
    url.searchParams.set("start", String(Math.floor(start)));
  }
  if (muted) {
    url.searchParams.set("mute", "1");
  }
  if (!controls) {
    url.searchParams.set("controls", "0");
  }
  if (origin != null) {
    url.searchParams.set("origin", origin);
  }
  return url.toString();
}
