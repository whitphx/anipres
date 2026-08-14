import type { FrameAction } from "../timeline-model";

/** Satisfied by both a derived `StepData` and an edited `EditedStep`. */
interface StepLike {
  batches: readonly { frames: readonly { action: FrameAction }[] }[];
}

/**
 * Whether a timeline edit would newly leave a video with two playback
 * events firing at once.
 *
 * A step's batches run concurrently, so two events of one video in
 * separate batches have no order between them and the player ends up in
 * whichever state the API applied last. Events sharing a track are
 * already caught by the same-track-split diagnostic, but a video holds
 * events on two tracks as soon as one of them joins a keyframe's batch,
 * and nothing downstream sees those two as related. Events within one
 * batch run in sequence, so they are not a conflict.
 *
 * An event with no `videoKey` names no video and nothing runs for it,
 * so it cannot be paired with anything.
 */
export function editIntroducesMediaConflict(
  before: readonly StepLike[],
  after: readonly StepLike[],
): boolean {
  // Introduces, not holds: the edited layout covers the whole timeline,
  // so a pair reached some other way would otherwise block every later
  // edit, including the one that would resolve it.
  return (
    hasSimultaneousMediaEvents(after) && !hasSimultaneousMediaEvents(before)
  );
}

function hasSimultaneousMediaEvents(steps: readonly StepLike[]): boolean {
  for (const step of steps) {
    const videosInStep = new Set<string>();
    for (const batch of step.batches) {
      const videosInBatch = new Set<string>();
      for (const frame of batch.frames) {
        if (frame.action.type === "mediaControl" && frame.action.videoKey) {
          videosInBatch.add(frame.action.videoKey);
        }
      }
      for (const videoKey of videosInBatch) {
        if (videosInStep.has(videoKey)) {
          return true;
        }
        videosInStep.add(videoKey);
      }
    }
  }
  return false;
}
