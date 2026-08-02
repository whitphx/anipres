// Runtime view of a TimelineDoc for playback and UI: steps of batches of
// frames, with the step index materialized. Frames carry their shapeId so
// consumers address shapes directly (robust under duplicate frame ids).

import type { FrameAction, TimelineDoc } from "./types";

export interface RuntimeFrame {
  id: string;
  shapeId: string;
  type: "cue" | "sub";
  action: FrameAction;
}
export interface RuntimeBatch {
  id: string;
  trackId: string;
  stepIndex: number;
  data: RuntimeFrame[]; // [cue, ...subs]
}
export type RuntimeStep = RuntimeBatch[];

export function timelineDocToRuntimeSteps(doc: TimelineDoc): RuntimeStep[] {
  return doc.steps.map((step, stepIndex) =>
    step.batches.map((batch) => ({
      // Keyed by the cue SHAPE id — unique by tldraw's guarantee, unlike
      // stored frame ids, which duplicate-id corruption can collide.
      id: `batch-${batch.frames[0]?.shapeId ?? "empty"}`,
      trackId: batch.trackId,
      stepIndex,
      data: batch.frames.map((frame, frameIndex) => ({
        id: frame.frameId,
        shapeId: frame.shapeId,
        type: frameIndex === 0 ? ("cue" as const) : ("sub" as const),
        action: frame.action,
      })),
    })),
  );
}
