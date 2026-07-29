import { describe, it, expect } from "vitest";
import {
  findFramePosition,
  planDetachedReattach,
  planSubFrameAddAfter,
} from "./operations";
import {
  deriveTimeline,
  frameToMetaJson,
  compareOrderKeys,
} from "../timeline-model";
import type { CueFrame, Frame, SubFrame } from "../timeline-model";

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

function makeDoc(entries: { shapeId: string; frame: Frame }[]) {
  const doc = deriveTimeline({
    shapes: entries.map(({ shapeId, frame }) => ({
      shapeId,
      frameMeta: frameToMetaJson(frame),
    })),
    pageId: "page:page",
  });
  const byShapeId = new Map(entries.map((e) => [e.shapeId, e.frame]));
  const getStoredFrame = (shapeId: string) => byShapeId.get(shapeId) ?? null;
  return { doc, getStoredFrame };
}

// Every scenario here involves DUPLICATED stored frame ids (lossless
// rule 4 keeps such frames in the derived doc), so any lookup by frame id
// would resolve to the wrong frame. All operations must key by shapeId.

describe("findFramePosition (shapeId identity)", () => {
  it("resolves each of two same-frame.id cues to its own step and track (add-cue-after, group duplication)", () => {
    const { doc } = makeDoc([
      { shapeId: "shape:x", frame: cue("dup", "s1", "a1", "T1") },
      { shapeId: "shape:y", frame: cue("dup", "s2", "a2", "T2") },
    ]);
    const first = findFramePosition(doc, "shape:x");
    const second = findFramePosition(doc, "shape:y");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // "Add cue after" on the SECOND cue must use the second frame's
    // actual step and track — and group duplication derives source
    // positions the same way.
    expect(second!.stepIndex).toBe(1);
    expect(second!.batch.trackId).toBe("T2");
    expect(second!.batch.frames[second!.frameIndex].shapeId).toBe("shape:y");
    expect(first!.stepIndex).toBe(0);
    expect(first!.batch.trackId).toBe("T1");
  });
});

describe("planSubFrameAddAfter (shapeId insertion identity)", () => {
  it("re-keys the correct shapes when two same-frame.id sub frames share a collision run", () => {
    const { doc, getStoredFrame } = makeDoc([
      { shapeId: "shape:c", frame: cue("c1", "s1", "a1", "T") },
      { shapeId: "shape:s1", frame: sub("dupsub", "c1", "a1") },
      { shapeId: "shape:s2", frame: sub("dupsub", "c1", "a1") },
    ]);
    // Insert between the two equal-key subs (after the first one). With
    // frame-id insertion identity, both entries would be "dupsub" and the
    // re-key updates could land on the wrong shape.
    const plan = planSubFrameAddAfter({
      doc,
      prevShapeId: "shape:s1",
      getStoredFrame,
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameId).toBe("c1");
    // The collision run is normalized deterministically and each update
    // targets a distinct shape.
    expect(plan!.keyUpdates.map((u) => u.shapeId).sort()).toEqual([
      "shape:s1",
      "shape:s2",
    ]);
    const keyByShape = new Map(plan!.keyUpdates.map((u) => [u.shapeId, u.key]));
    expect(
      compareOrderKeys(keyByShape.get("shape:s1")!, plan!.orderKey),
    ).toBeLessThan(0);
    expect(
      compareOrderKeys(plan!.orderKey, keyByShape.get("shape:s2")!),
    ).toBeLessThan(0);
  });

  it("appends after the last sub without touching other frames", () => {
    const { doc, getStoredFrame } = makeDoc([
      { shapeId: "shape:c", frame: cue("c1", "s1", "a1", "T") },
      { shapeId: "shape:s1", frame: sub("dupsub", "c1", "a1") },
      { shapeId: "shape:s2", frame: sub("dupsub", "c1", "a2") },
    ]);
    const plan = planSubFrameAddAfter({
      doc,
      prevShapeId: "shape:s2",
      getStoredFrame,
    });
    expect(plan).not.toBeNull();
    expect(plan!.keyUpdates).toEqual([]);
    expect(compareOrderKeys("a2", plan!.orderKey)).toBeLessThan(0);
  });
});

describe("planDetachedReattach (shapeId target identity)", () => {
  it("appends into the selected cue's own batch, not another cue with the same frame.id", () => {
    // shape:cueA is the representative for the ambiguous "dupcue"
    // reference, so the existing sub (key "a5") attaches to ITS batch.
    // Reattaching onto shape:cueB must key relative to cueB's (empty)
    // batch — a key above "a5" would prove the wrong batch was targeted.
    const { doc, getStoredFrame } = makeDoc([
      { shapeId: "shape:cueA", frame: cue("dupcue", "s1", "a1", "T1") },
      { shapeId: "shape:cueB", frame: cue("dupcue", "s2", "a2", "T2") },
      { shapeId: "shape:sub", frame: sub("f-sub", "dupcue", "a5") },
    ]);
    const plan = planDetachedReattach({
      doc,
      cueShapeId: "shape:cueB",
      getStoredFrame,
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameId).toBe("dupcue");
    expect(compareOrderKeys(plan!.orderKey, "a5")).toBeLessThan(0);
  });

  it("appends after the selected cue's last sub frame", () => {
    const { doc, getStoredFrame } = makeDoc([
      { shapeId: "shape:cueA", frame: cue("c1", "s1", "a1", "T1") },
      { shapeId: "shape:sub", frame: sub("f-sub", "c1", "a3") },
    ]);
    const plan = planDetachedReattach({
      doc,
      cueShapeId: "shape:cueA",
      getStoredFrame,
    });
    expect(plan).not.toBeNull();
    expect(compareOrderKeys("a3", plan!.orderKey)).toBeLessThan(0);
  });
});
