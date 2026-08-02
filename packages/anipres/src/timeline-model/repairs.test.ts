import { describe, it, expect } from "vitest";
import { planDuplicateFrameIdRepair } from "./repairs";
import { deriveTimeline } from "./derive";
import { frameToMetaJson } from "./parse";
import type { CueFrame, Frame, SubFrame } from "./types";

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
    action: { type: "shapeAnimation" },
  };
}
function sub(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return {
    v: 2,
    id,
    type: "sub",
    cueFrameId,
    orderKey,
    action: { type: "shapeAnimation" },
  };
}

function makeMinter() {
  let n = 0;
  return () => `minted-${++n}`;
}

describe("planDuplicateFrameIdRepair", () => {
  it("keeps the id on the smallest-shapeId CUE even when a sub frame's shape sorts first", () => {
    // Reviewer scenario (finding 6): a sub frame whose OWN id is
    // "duplicate" sorts first by shape id; the cue must keep the id so
    // the referencing sub frame stays attached.
    const currentFrames: { shapeId: string; frame: Frame }[] = [
      { shapeId: "shape:a", frame: sub("duplicate", "elsewhere", "a0") },
      { shapeId: "shape:b", frame: cue("duplicate", "s1", "a1", "T") },
      { shapeId: "shape:c", frame: sub("f-ref", "duplicate", "a0") },
    ];
    const plan = planDuplicateFrameIdRepair(
      currentFrames,
      "duplicate",
      makeMinter(),
    );
    // Only the sub frame that carried the duplicated id is rewritten.
    expect(plan.updates.map((u) => u.shapeId)).toEqual(["shape:a"]);
    expect(plan.updates[0].frame.id).not.toBe("duplicate");

    // Apply the plan and re-derive: the cue retains "duplicate" and the
    // referencing sub frame remains attached to its batch.
    const repaired = currentFrames.map((entry) => {
      const update = plan.updates.find((u) => u.shapeId === entry.shapeId);
      return update ?? entry;
    });
    const doc = deriveTimeline({
      shapes: repaired.map(({ shapeId, frame }) => ({
        shapeId,
        frameMeta: frameToMetaJson(frame),
      })),
    });
    expect(
      doc.diagnostics.filter((d) => d.type === "duplicate-frame-id"),
    ).toEqual([]);
    const batch = doc.steps
      .flatMap((step) => step.batches)
      .find((b) => b.frames[0].shapeId === "shape:b");
    expect(batch?.frames.map((f) => f.shapeId)).toContain("shape:c");
  });

  it("falls back to the smallest-shapeId record when no cue is involved", () => {
    const plan = planDuplicateFrameIdRepair(
      [
        { shapeId: "shape:b", frame: sub("dup", "c1", "a0") },
        { shapeId: "shape:a", frame: sub("dup", "c1", "a1") },
      ],
      "dup",
      makeMinter(),
    );
    expect(plan.updates.map((u) => u.shapeId)).toEqual(["shape:b"]);
  });

  it("plans nothing when the id is not duplicated", () => {
    const plan = planDuplicateFrameIdRepair(
      [{ shapeId: "shape:a", frame: cue("solo", "s1", "a1", "T") }],
      "solo",
      makeMinter(),
    );
    expect(plan.updates).toEqual([]);
  });
});
