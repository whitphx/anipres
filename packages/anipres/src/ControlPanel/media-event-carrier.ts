import type { TimelineDoc } from "../timeline-model";
import { getVideoKey } from "../shapes/youtube-embed/YouTubeEmbedShape";

/** Where a carrier stands relative to the step being viewed. */
const ON_STAGE = 0;
const UPCOMING = 1;
const UNFRAMED = 2;

interface CarrierRank {
  standing: typeof ON_STAGE | typeof UPCOMING | typeof UNFRAMED;
  position: number;
  id: string;
}

/**
 * Picks the one carrier per video that a new playback event attaches
 * to: the one the video is showing at the current step.
 *
 * A video that moves is several carriers, so a selection can hold more
 * than one of the same video while still being a single request about
 * a single video. Which one wins decides the step the event runs in, so
 * it cannot come from the selection's own order — a selection is a set,
 * and two selections that look identical would then place the event
 * differently. Taking the carrier on stage puts the event where the
 * user is looking, and leaves the video's later keyframes ahead of it,
 * which is what a drag needs to merge the event in front of one.
 *
 * A selection entirely ahead of the current step has nothing on stage,
 * so the first of those carriers wins — the one the video reaches next.
 * A carrier holding no frame has no position at all and loses to any
 * carrier that has one, the event then becoming a cue frame in a new
 * step. Ties fall back to the shape id, which is arbitrary but at least
 * the same every time.
 */
export function pickMediaEventCarriers<
  T extends { id: string; meta?: Record<string, unknown> },
>(doc: TimelineDoc, currentStepIndex: number, shapes: readonly T[]): T[] {
  const placeByShapeId = new Map<
    string,
    { stepIndex: number; position: number }
  >();
  let position = 0;
  for (let stepIndex = 0; stepIndex < doc.steps.length; stepIndex++) {
    for (const batch of doc.steps[stepIndex].batches) {
      for (const frame of batch.frames) {
        placeByShapeId.set(frame.shapeId, { stepIndex, position: position++ });
      }
    }
  }

  const rankOf = (shape: T): CarrierRank => {
    const place = placeByShapeId.get(shape.id);
    if (place == null) {
      return { standing: UNFRAMED, position: -1, id: shape.id };
    }
    return {
      standing: place.stepIndex <= currentStepIndex ? ON_STAGE : UPCOMING,
      position: place.position,
      id: shape.id,
    };
  };

  const beats = (a: CarrierRank, b: CarrierRank): boolean => {
    if (a.standing !== b.standing) {
      return a.standing < b.standing;
    }
    if (a.position !== b.position) {
      // The last one reached among those on stage; the next one due
      // among those still ahead.
      return a.standing === ON_STAGE
        ? a.position > b.position
        : a.position < b.position;
    }
    return a.id > b.id;
  };

  const pickedPerVideo = new Map<string, { shape: T; rank: CarrierRank }>();
  for (const shape of shapes) {
    const videoKey = getVideoKey(shape);
    const rank = rankOf(shape);
    const incumbent = pickedPerVideo.get(videoKey);
    if (incumbent == null || beats(rank, incumbent.rank)) {
      pickedPerVideo.set(videoKey, { shape, rank });
    }
  }
  return [...pickedPerVideo.values()].map(({ shape }) => shape);
}
