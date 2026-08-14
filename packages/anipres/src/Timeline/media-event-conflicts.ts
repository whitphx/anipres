import type { EditedStep } from "../timeline-model";

/**
 * Whether a step layout would fire two playback events for one video at
 * the same time.
 *
 * A step's batches run concurrently, so two events of one video in
 * separate batches have no order between them and the player ends up in
 * whichever state the API applied last. Events sharing a track are
 * already caught by the same-track-split diagnostic, but a video holds
 * events on two tracks as soon as one of them joins a keyframe's batch,
 * and nothing downstream sees those two as related. Events within one
 * batch run in sequence, so they are not a conflict.
 *
 * An event whose `videoKey` is absent names no video yet (normalization
 * fills it in from the binding) and cannot be paired with anything.
 */
export function hasSimultaneousMediaEvents(steps: EditedStep[]): boolean {
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
