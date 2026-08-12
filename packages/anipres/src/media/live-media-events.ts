import type { Editor, TLShape } from "tldraw";
import {
  getVideoKey,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import { parseFrameMeta } from "../timeline-model/parse";

/** The least a record has to be for the rule below to read it. */
interface TimelineShape {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
}

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
 * Everything that derives a timeline or counts steps goes through here
 * — the runtime, the agent's perception of the deck, a snapshot counted
 * without an editor — because a reader counting the steps this rule
 * drops would number every later step differently from the steps the
 * user sees and the presentation plays.
 *
 * How a marker names its video is the caller's to answer, a live editor
 * having a store to ask where a bare snapshot has only the records.
 */
function timelineShapesOf<T extends TimelineShape>(
  shapes: readonly T[],
  markerVideoKey: (shape: T) => string | null,
): T[] {
  const liveVideoKeys = new Set(
    shapes
      .filter((shape) => shape.type === YouTubeEmbedShapeType)
      .map((shape) => getVideoKey(shape)),
  );
  return shapes.filter((shape) => {
    if (shape.type !== MediaControlShapeType) {
      return true;
    }
    const videoKey = markerVideoKey(shape);
    return videoKey != null && liveVideoKeys.has(videoKey);
  });
}

/** The editor's answer: `resolveMediaControlVideoKey` reads the store. */
export function timelineShapesOfEditor(
  editor: Editor,
  shapes: readonly TLShape[],
): TLShape[] {
  return timelineShapesOf(shapes, (shape) =>
    resolveMediaControlVideoKey(editor, shape.id),
  );
}

/**
 * The same answer from records alone, for a snapshot counted without an
 * editor.
 */
export function timelineShapesOfRecords<T extends TimelineShape>(
  shapes: readonly T[],
): T[] {
  return timelineShapesOf(shapes, (shape) => {
    const parsed = parseFrameMeta(shape.meta?.frame);
    return parsed.kind === "v2" && parsed.frame.action.type === "mediaControl"
      ? (parsed.frame.action.videoKey ?? null)
      : null;
  });
}
