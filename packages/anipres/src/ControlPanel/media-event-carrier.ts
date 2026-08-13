import type { TimelineDoc } from "../timeline-model";
import { getVideoKey } from "../shapes/youtube-embed/YouTubeEmbedShape";

/**
 * Picks the one carrier per video that a new playback event attaches
 * to: the last of the selected carriers in presentation order.
 *
 * A video that moves is several carriers, so a selection can hold more
 * than one of the same video while still being a single request about
 * a single video. Which one wins decides the step the event runs in,
 * so it cannot come from the selection's own order — a selection is a
 * set, and two selections that look identical would then place the
 * event differently. Taking the last means the event follows all the
 * movement the selection covers, and selecting the whole video puts it
 * at the end, where every event used to go.
 *
 * A carrier holding no frame has no position and so loses to any
 * carrier that has one, the event then becoming a cue frame in a new
 * step. Carriers that tie — several unframed ones — fall back to the
 * shape id, which is arbitrary but at least the same every time.
 */
export function pickMediaEventCarriers<
  T extends { id: string; meta?: Record<string, unknown> },
>(doc: TimelineDoc, shapes: readonly T[]): T[] {
  const positionByShapeId = new Map<string, number>();
  let position = 0;
  for (const step of doc.steps) {
    for (const batch of step.batches) {
      for (const frame of batch.frames) {
        positionByShapeId.set(frame.shapeId, position++);
      }
    }
  }
  const isLater = (shape: T, than: T) => {
    const shapePosition = positionByShapeId.get(shape.id) ?? -1;
    const thanPosition = positionByShapeId.get(than.id) ?? -1;
    return shapePosition === thanPosition
      ? shape.id > than.id
      : shapePosition > thanPosition;
  };

  const latestPerVideo = new Map<string, T>();
  for (const shape of shapes) {
    const videoKey = getVideoKey(shape);
    const incumbent = latestPerVideo.get(videoKey);
    if (incumbent == null || isLater(shape, incumbent)) {
      latestPerVideo.set(videoKey, shape);
    }
  }
  return [...latestPerVideo.values()];
}
