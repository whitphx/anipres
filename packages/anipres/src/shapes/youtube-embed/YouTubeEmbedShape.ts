import { T } from "tldraw";
import type { TLBaseShape, RecordProps, TLShape } from "tldraw";

export const YouTubeEmbedShapeType = "youtube-embed" as const;

export interface YouTubeEmbedShapeProps {
  w: number;
  h: number;
  /** The URL the user pasted, kept for display and re-editing. */
  url: string;
  /** Extracted YouTube video id; "" while the shape has no video yet. */
  videoId: string;
  /** Playback start position in seconds. */
  start: number;
  /**
   * Start the player muted. Muted playback is exempt from browser
   * autoplay blocking, so this is the reliable choice for decks that
   * play a video on their very first step.
   */
  muted: boolean;
  /** Show YouTube's own player controls inside the iframe. */
  controls: boolean;
  altText: string;
}

export type YouTubeEmbedShape = TLBaseShape<
  typeof YouTubeEmbedShapeType,
  YouTubeEmbedShapeProps
>;

export const youTubeEmbedShapeProps: RecordProps<YouTubeEmbedShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  url: T.string,
  videoId: T.string,
  start: T.positiveNumber,
  muted: T.boolean,
  controls: T.boolean,
  altText: T.string,
};

/**
 * Which video instance a carrier belongs to — shared by every carrier
 * of one video, so a video that moves across steps is several shapes
 * with one key. Media events target this key, and the runtime mounts
 * exactly one player per key.
 *
 * Deliberately in `meta`, not in props: tldraw validates custom shape
 * props and rejects one it does not know, so a `videoKey` prop would
 * make any document that used this feature fail to load on a release
 * that predates it — the whole document, not the video. `meta` is
 * unvalidated, which is also why a frame's own data lives there, so an
 * older build simply ignores it and the document still opens.
 *
 * A carrier without one is a video that has never been copied, and it
 * answers with its own shape id: correct, because a video was exactly
 * one shape until it was.
 */
export function getVideoKey(shape: {
  id: string;
  meta?: Record<string, unknown>;
}): string {
  const videoKey = shape.meta?.videoKey;
  return typeof videoKey === "string" && videoKey !== "" ? videoKey : shape.id;
}

export function isYouTubeEmbedShape(
  shape: TLShape | undefined | null,
): shape is YouTubeEmbedShape {
  return shape?.type === YouTubeEmbedShapeType;
}
