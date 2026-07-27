import { describe, it, expect } from "vitest";
import { moveFrame } from "./frame-movement";
import { calcFrameBatchUIData } from "./frame-ui-data";
import { deriveTimeline } from "../timeline-model";
import type { CueFrame, EditedStep, SubFrame } from "../timeline-model";

// Build UI data from a v2 document — the same path the Timeline uses.
function makeSteps(
  framesPerShape: { shapeId: string; frame: CueFrame | SubFrame }[],
) {
  const doc = deriveTimeline({
    shapes: framesPerShape.map(({ shapeId, frame }) => ({
      shapeId,
      frameMeta: frame,
    })),
    pageId: "page:page",
  });
  return calcFrameBatchUIData(doc).steps;
}

const ACTION = { type: "shapeAnimation" as const };
function cue(
  id: string,
  stepId: string,
  stepOrderKey: string,
  trackId: string,
): CueFrame {
  return {
    v: 2,
    id,
    type: "cue",
    trackId,
    stepId,
    stepOrderKey,
    action: ACTION,
  };
}
function sub(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return { v: 2, id, type: "sub", cueFrameId, orderKey, action: ACTION };
}

function layout(steps: EditedStep[] | undefined) {
  return steps?.map((step) =>
    step.map(
      (batch) => `${batch.trackId}:${batch.frames.map((f) => f.id).join(",")}`,
    ),
  );
}

// Base document: track T has batches in steps 0 and 2; track U in step 1.
// Step 2's batch has a sub frame.
const BASE = [
  { shapeId: "shape:1", frame: cue("t1", "s1", "a1", "T") },
  { shapeId: "shape:2", frame: cue("u1", "s2", "a2", "U") },
  { shapeId: "shape:3", frame: cue("t2", "s3", "a3", "T") },
  { shapeId: "shape:4", frame: sub("t3", "t2", "a0") },
];

describe("moveFrame", () => {
  it("moves a whole batch right into an empty gap ('after')", () => {
    const steps = makeSteps(BASE);
    // Move T's first batch (step 0) after step 1.
    const result = moveFrame(steps, "T", 0, 0, 1, "after");
    expect(layout(result)).toEqual([["U:u1"], ["T:t1"], ["T:t2,t3"]]);
  });

  it("merges into an existing same-track batch on drop 'at' (cue demoted to sub)", () => {
    const steps = makeSteps(BASE);
    // Move T's first batch onto step 2 (which holds T's t2 batch).
    const result = moveFrame(steps, "T", 0, 0, 2, "at");
    expect(layout(result)).toEqual([
      ["U:u1"],
      ["T:t1,t2,t3"], // t2 (was cue) continues the moved batch as a sub
    ]);
  });

  it("splits a batch when moving only its sub frame right", () => {
    const steps = makeSteps(BASE);
    // t3 is the sub frame of the step-2 batch (trackIndex 2).
    const result = moveFrame(steps, "T", 2, 2, 2, "after");
    expect(layout(result)).toEqual([
      ["T:t1"],
      ["U:u1"],
      ["T:t2"],
      ["T:t3"], // pushed out into its own new step, promoted to cue
    ]);
  });

  it("moves a whole batch left, sweeping earlier same-track batches along (track order is invariant)", () => {
    const steps = makeSteps(BASE);
    // Drag the batch's LAST frame (t3, trackIndex 2) left before all: the
    // whole t2 batch moves, and t1's batch — an intermediate same-track
    // batch — is pushed along so the track's keyframe order is preserved.
    const result = moveFrame(steps, "T", 2, 2, -1, "after");
    expect(layout(result)).toEqual([["T:t1"], ["T:t2,t3"], ["U:u1"]]);
  });

  it("merges left into an existing same-track batch on drop 'at'", () => {
    const steps = makeSteps(BASE);
    // Drag t3 (last frame, trackIndex 2) to move the whole t2 batch onto
    // step 0 (which holds T's t1 batch).
    const result = moveFrame(steps, "T", 2, 2, 0, "at");
    expect(layout(result)).toEqual([
      ["T:t1,t2,t3"], // t2 demoted to sub, continuing t1's batch
      ["U:u1"],
    ]);
  });

  it("sweeps up intermediate same-track batches when moving across them", () => {
    const steps = makeSteps([
      { shapeId: "shape:1", frame: cue("t1", "s1", "a1", "T") },
      { shapeId: "shape:2", frame: cue("t2", "s2", "a2", "T") },
      { shapeId: "shape:3", frame: cue("u1", "s3", "a3", "U") },
    ]);
    // Move t1's batch to after step 2: passes over t2's batch, which is
    // pushed along, each retaining its own batch/step.
    const result = moveFrame(steps, "T", 0, 0, 2, "after");
    expect(layout(result)).toEqual([["U:u1"], ["T:t1"], ["T:t2"]]);
  });

  it("splitting off a batch's cue moving left promotes the remaining sub to cue", () => {
    const steps = makeSteps(BASE);
    // Drag t2 (the CUE of step 2's batch, trackIndex 1) left before all:
    // the batch splits — t2 moves (sweeping t1's batch along), t3 stays
    // behind promoted to cue of its own batch.
    const result = moveFrame(steps, "T", 2, 1, -1, "after");
    expect(layout(result)).toEqual([["T:t1"], ["T:t2"], ["U:u1"], ["T:t3"]]);
  });
});
