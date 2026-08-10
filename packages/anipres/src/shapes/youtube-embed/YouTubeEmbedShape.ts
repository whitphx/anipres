import { T } from "tldraw";
import type { TLBaseShape, RecordProps, TLShape } from "tldraw";

export const YouTubeEmbedShapeType = "youtube-embed" as const;

export interface YouTubeEmbedShapeProps {
  w: number;
  h: number;
  /**
   * Which video instance this shape carries — shared by every carrier
   * of one video, so a video that moves across steps is several shapes
   * with one key. Media events target this key rather than a shape id,
   * and the runtime mounts exactly one player per key.
   *
   * Absent on records written before the prop existed — validated as
   * optional so such a document loads at all, since the store validates
   * a snapshot before any normalization can touch it. Read it through
   * {@link getVideoKey}, which falls back to the shape's own id.
   */
  videoKey?: string;
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
  videoKey: T.string.optional(),
  url: T.string,
  videoId: T.string,
  start: T.positiveNumber,
  muted: T.boolean,
  controls: T.boolean,
  altText: T.string,
};

/**
 * The video identity a carrier belongs to. Records predating the
 * `videoKey` prop fall back to their own shape id, which is correct
 * because a video was exactly one shape before carriers could be
 * copied — and is what normalization materializes.
 */
export function getVideoKey(shape: YouTubeEmbedShape): string {
  const videoKey = shape.props.videoKey;
  return videoKey != null && videoKey !== "" ? videoKey : shape.id;
}

export function isYouTubeEmbedShape(
  shape: TLShape | undefined | null,
): shape is YouTubeEmbedShape {
  return shape?.type === YouTubeEmbedShapeType;
}
