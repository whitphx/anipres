import { T } from "tldraw";
import type { TLBaseShape, RecordProps } from "tldraw";

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
