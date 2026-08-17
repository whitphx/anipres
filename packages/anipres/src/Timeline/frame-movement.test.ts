import { describe, it, expect } from "vitest";
import { moveFrame, reorderFrameWithinBatch } from "./frame-movement";
import { calcFrameBatchUIData } from "./frame-ui-data";
import { deriveTimeline, reconcileEditedSteps } from "../timeline-model";
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
  });
  const { steps, stepSources } = calcFrameBatchUIData(doc);
  return { steps, stepSources };
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
    step.batches.map(
      (batch) =>
        `${batch.trackId}:${batch.frames.map((f) => f.frameId).join(",")}`,
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
    const { steps, stepSources } = makeSteps(BASE);
    // Move T's first batch (step 0) after step 1.
    const result = moveFrame(steps, stepSources, "T", 0, 0, 1, "after");
    expect(layout(result)).toEqual([["U:u1"], ["T:t1"], ["T:t2,t3"]]);
  });

  it("merges into an existing same-track batch on drop 'at' (cue demoted to sub)", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // Move T's first batch onto step 2 (which holds T's t2 batch).
    const result = moveFrame(steps, stepSources, "T", 0, 0, 2, "at");
    expect(layout(result)).toEqual([
      ["U:u1"],
      ["T:t1,t2,t3"], // t2 (was cue) continues the moved batch as a sub
    ]);
  });

  it("splits a batch when moving only its sub frame right", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // t3 is the sub frame of the step-2 batch (trackIndex 2).
    const result = moveFrame(steps, stepSources, "T", 2, 2, 2, "after");
    expect(layout(result)).toEqual([
      ["T:t1"],
      ["U:u1"],
      ["T:t2"],
      ["T:t3"], // pushed out into its own new step, promoted to cue
    ]);
  });

  it("moves a whole batch left, sweeping earlier same-track batches along (track order is invariant)", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // Drag the batch's LAST frame (t3, trackIndex 2) left before all: the
    // whole t2 batch moves, and t1's batch — an intermediate same-track
    // batch — is pushed along so the track's keyframe order is preserved.
    const result = moveFrame(steps, stepSources, "T", 2, 2, -1, "after");
    expect(layout(result)).toEqual([["T:t1"], ["T:t2,t3"], ["U:u1"]]);
  });

  it("merges left into an existing same-track batch on drop 'at'", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // Drag t3 (last frame, trackIndex 2) to move the whole t2 batch onto
    // step 0 (which holds T's t1 batch).
    const result = moveFrame(steps, stepSources, "T", 2, 2, 0, "at");
    expect(layout(result)).toEqual([
      ["T:t1,t2,t3"], // t2 demoted to sub, continuing t1's batch
      ["U:u1"],
    ]);
  });

  it("sweeps up intermediate same-track batches when moving across them", () => {
    const { steps, stepSources } = makeSteps([
      { shapeId: "shape:1", frame: cue("t1", "s1", "a1", "T") },
      { shapeId: "shape:2", frame: cue("t2", "s2", "a2", "T") },
      { shapeId: "shape:3", frame: cue("u1", "s3", "a3", "U") },
    ]);
    // Move t1's batch to after step 2: passes over t2's batch, which is
    // pushed along, each retaining its own batch/step.
    const result = moveFrame(steps, stepSources, "T", 0, 0, 2, "after");
    expect(layout(result)).toEqual([["U:u1"], ["T:t1"], ["T:t2"]]);
  });

  it("splitting off a batch's cue moving left promotes the remaining sub to cue", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // Drag t2 (the CUE of step 2's batch, trackIndex 1) left before all:
    // the batch splits — t2 moves (sweeping t1's batch along), t3 stays
    // behind promoted to cue of its own batch.
    const result = moveFrame(steps, stepSources, "T", 2, 1, -1, "after");
    expect(layout(result)).toEqual([["T:t1"], ["T:t2"], ["U:u1"], ["T:t3"]]);
  });
});

describe("reorderFrameWithinBatch", () => {
  // Track T: one batch in step 0 (t1), one in step 2 whose frames are
  // t2 (cue), t3, t4. Track U sits in step 1 and must never move.
  const THREE = [
    { shapeId: "shape:1", frame: cue("t1", "s1", "a1", "T") },
    { shapeId: "shape:2", frame: cue("u1", "s2", "a2", "U") },
    { shapeId: "shape:3", frame: cue("t2", "s3", "a3", "T") },
    { shapeId: "shape:4", frame: sub("t3", "t2", "a0") },
    { shapeId: "shape:5", frame: sub("t4", "t2", "a1") },
  ];
  // Track T's frames are numbered across the whole timeline, so the
  // step-2 batch occupies trackIndex 1..3.
  const [T2, T3, T4] = [1, 2, 3];

  it("demotes the cue when it moves back, promoting what now leads", () => {
    const { steps, stepSources } = makeSteps(THREE);
    const result = reorderFrameWithinBatch(steps, stepSources, "T", 2, T2, T4);
    expect(layout(result)).toEqual([["T:t1"], ["U:u1"], ["T:t3,t4,t2"]]);
  });

  it("promotes a sub dragged to the front", () => {
    const { steps, stepSources } = makeSteps(THREE);
    const result = reorderFrameWithinBatch(steps, stepSources, "T", 2, T4, T2);
    expect(layout(result)).toEqual([["T:t1"], ["U:u1"], ["T:t4,t2,t3"]]);
  });

  it("moves only the dragged frame, never the ones behind it", () => {
    // The across-steps move pushes the far side of the batch along; a
    // reorder must not, or a batch of three would be unreadable.
    const { steps, stepSources } = makeSteps(THREE);
    const result = reorderFrameWithinBatch(steps, stepSources, "T", 2, T3, T4);
    expect(layout(result)).toEqual([["T:t1"], ["U:u1"], ["T:t2,t4,t3"]]);
  });

  it("swaps the two frames of a two-frame batch", () => {
    const { steps, stepSources } = makeSteps(BASE);
    // BASE's step-2 batch is t2 (cue, trackIndex 1) + t3 (trackIndex 2).
    const result = reorderFrameWithinBatch(steps, stepSources, "T", 2, 2, 1);
    expect(layout(result)).toEqual([["T:t1"], ["U:u1"], ["T:t3,t2"]]);
  });

  it("declines a drop onto the frame's own place", () => {
    const { steps, stepSources } = makeSteps(THREE);
    expect(
      reorderFrameWithinBatch(steps, stepSources, "T", 2, T3, T3),
    ).toBeUndefined();
  });

  it("declines a destination outside the dragged frame's batch", () => {
    const { steps, stepSources } = makeSteps(THREE);
    // t1 is track T's other batch, a step away: dropping onto it still
    // means "merge at its step", which is moveFrame's business.
    expect(
      reorderFrameWithinBatch(steps, stepSources, "T", 2, T2, 0),
    ).toBeUndefined();
    // A step that holds no batch of this track at all.
    expect(
      reorderFrameWithinBatch(steps, stepSources, "T", 1, T2, T3),
    ).toBeUndefined();
  });

  it("keeps every step's source identity, including the reordered one", () => {
    const { steps, stepSources } = makeSteps(THREE);
    const result = reorderFrameWithinBatch(steps, stepSources, "T", 2, T2, T4);
    expect(result?.map((step) => step.source?.id)).toEqual(
      stepSources.map((source) => source.id),
    );
  });

  it("writes only the reordered batch's frames, keeping the step's identity", () => {
    const frames = THREE;
    const { steps, stepSources } = makeSteps(frames);
    const edited = reorderFrameWithinBatch(steps, stepSources, "T", 2, T2, T4);

    let minted = 0;
    const result = reconcileEditedSteps({
      currentFrames: frames,
      editedSteps: edited!,
      mintId: () => `minted-${++minted}`,
    });
    // Bounded to the batch: the two frames whose roles swapped plus the
    // one whose `cueFrameId` now names a different cue. The step is led
    // by a frame that was a sub until now, which has no stored step
    // identity of its own; the carried source supplies it, so no other
    // step is re-keyed and no step id is minted.
    expect(result.updates.map((u) => u.shapeId).sort()).toEqual([
      "shape:3",
      "shape:4",
      "shape:5",
    ]);

    const updatedByShapeId = new Map(
      result.updates.map((u) => [u.shapeId, u.frame]),
    );
    const applied = frames.map(({ shapeId, frame }) => ({
      shapeId,
      frameMeta: updatedByShapeId.get(shapeId) ?? frame,
    }));
    const doc = deriveTimeline({ shapes: applied });

    expect(doc.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(doc.diagnostics).toEqual([]);
    const reordered = doc.steps[2].batches.find((b) => b.trackId === "T");
    expect(reordered?.frames.map((f) => f.frameId)).toEqual(["t3", "t4", "t2"]);
    // The promoted frame carries the batch's track, and the demoted one
    // now hangs off it.
    const promoted = updatedByShapeId.get("shape:4") as CueFrame;
    expect(promoted.type).toBe("cue");
    expect(promoted.trackId).toBe("T");
    expect((updatedByShapeId.get("shape:3") as SubFrame).cueFrameId).toBe(
      promoted.id,
    );
  });
});

// Regression guard for before-first insertion: reconciling a move to the
// front generates a key BELOW the previous first step's key, which is
// capital-prefixed (e.g. "Zz" below "a0") and mis-sorts under
// localeCompare. Run the full pipeline — move, reconcile, apply, re-derive
// — so this fails if any sort site regresses to locale comparison.
describe("moveFrame → reconcile → derive round trip (before-first keys)", () => {
  it("a step dragged before the first step derives first", () => {
    let minted = 0;
    const mintId = () => `minted-${++minted}`;
    // Keys start at the lowest integer key so the generated
    // before-first key must be capital-prefixed.
    const frames = [
      { shapeId: "shape:1", frame: cue("t1", "s1", "a0", "T") },
      { shapeId: "shape:2", frame: cue("u1", "s2", "a1", "U") },
    ];
    const { steps, stepSources } = makeSteps(frames);

    // Drag U's batch (step 1) to before everything.
    const edited = moveFrame(steps, stepSources, "U", 1, 0, -1, "after");
    expect(edited).toBeTruthy();

    const result = reconcileEditedSteps({
      currentFrames: frames,
      editedSteps: edited!,
      mintId,
    });
    // Apply the reconciled updates to the frame set.
    const updatedByShapeId = new Map(
      result.updates.map((u) => [u.shapeId, u.frame]),
    );
    const applied = frames.map(({ shapeId, frame }) => ({
      shapeId,
      frame: updatedByShapeId.get(shapeId) ?? frame,
    }));

    const movedKey = (updatedByShapeId.get("shape:2") as CueFrame | undefined)
      ?.stepOrderKey;
    expect(movedKey).toBeTruthy();
    // The premise: the generated key is below "a0" only under code-unit
    // comparison; localeCompare would sort it after.
    expect(movedKey! < "a0").toBe(true);
    expect(movedKey!.localeCompare("a0")).toBeGreaterThan(0);

    const doc = deriveTimeline({
      shapes: applied.map(({ shapeId, frame }) => ({
        shapeId,
        frameMeta: frame,
      })),
    });
    expect(doc.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});
