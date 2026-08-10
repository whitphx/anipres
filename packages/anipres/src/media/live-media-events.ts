import type { Editor, TLShape } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";

/**
 * The shapes a timeline is derived from, which is not every shape that
 * happens to be present: a media event whose video has no carrier left
 * is no longer part of the presentation.
 *
 * Its marker record may well still be there — deleting one is a claim
 * about a video's last carrier that a client sharing the document
 * cannot make — but an event with nothing to control must not go on
 * occupying a step, which would leave a deleted video behind as a run
 * of empty waits. Deciding it by reading the store costs no write and
 * no arbitration: every client sees the same carriers and drops the
 * same events, and should the video come back, by undo or from a peer,
 * its events come back with it.
 *
 * Everything deriving a timeline goes through here, the agent's
 * perception of the deck as much as the runtime's own: a reader
 * counting steps this one drops would number every later step
 * differently from the steps the user sees and the presentation plays.
 */
export function timelineShapesOf(
  editor: Editor,
  shapes: readonly TLShape[],
): TLShape[] {
  const liveVideoKeys = new Set(
    shapes.filter(isYouTubeEmbedShape).map(getVideoKey),
  );
  return shapes.filter((shape) => {
    if (shape.type !== MediaControlShapeType) {
      return true;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    return videoKey != null && liveVideoKeys.has(videoKey);
  });
}
