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

function makeMinter() {
  let n = 0;
  return () => `minted-${++n}`;
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

/** Applies plan writes to the entry list and re-derives — the round trip. */
function rederive(
  entries: { shapeId: string; frame: Frame }[],
  writes: { shapeId: string; frame: Frame }[],
) {
  const merged = new Map(entries.map((e) => [e.shapeId, e.frame]));
  for (const write of writes) {
    merged.set(write.shapeId, write.frame);
  }
  return deriveTimeline({
    shapes: [...merged.entries()].map(([shapeId, frame]) => ({
      shapeId,
      frameMeta: frameToMetaJson(frame),
    })),
    pageId: "page:page",
  });
}

function batchOfCueShape(
  doc: ReturnType<typeof deriveTimeline>,
  shapeId: string,
) {
  return doc.steps
    .flatMap((step) => step.batches)
    .find((batch) => batch.frames[0].shapeId === shapeId);
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
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameId).toBe("c1");
    expect(plan!.cueFrameUpdate).toBeNull(); // unduplicated cue keeps its id
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
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.keyUpdates).toEqual([]);
    expect(compareOrderKeys("a2", plan!.orderKey)).toBeLessThan(0);
  });

  it("freshens a non-representative duplicate-id cue so the new sub attaches to IT (round trip)", () => {
    // Both cues store id "dup"; shape:cueA is the derivation
    // representative, so a sub referencing "dup" would attach to cueA —
    // not the batch the user is adding into.
    const entries = [
      { shapeId: "shape:cueA", frame: cue("dup", "s1", "a1", "T1") },
      { shapeId: "shape:cueB", frame: cue("dup", "s2", "a2", "T2") },
    ];
    const { doc, getStoredFrame } = makeDoc(entries);
    const plan = planSubFrameAddAfter({
      doc,
      prevShapeId: "shape:cueB",
      getStoredFrame,
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameUpdate).not.toBeNull();
    expect(plan!.cueFrameUpdate!.shapeId).toBe("shape:cueB");
    expect(plan!.cueFrameUpdate!.frame.id).toBe(plan!.cueFrameId);
    expect(plan!.cueFrameId).not.toBe("dup");

    // Apply the FULL plan and re-derive: the new sub must belong to the
    // selected cue's batch, not the representative's.
    const rederived = rederive(entries, [
      plan!.cueFrameUpdate!,
      {
        shapeId: "shape:new",
        frame: sub("new-sub", plan!.cueFrameId, plan!.orderKey),
      },
    ]);
    expect(rederived.detachedFrames).toEqual([]);
    expect(
      batchOfCueShape(rederived, "shape:cueB")!.frames.map((f) => f.shapeId),
    ).toEqual(["shape:cueB", "shape:new"]);
    expect(batchOfCueShape(rederived, "shape:cueA")!.frames).toHaveLength(1);
  });

  it("does not change the representative cue's id when targeting it", () => {
    const entries = [
      { shapeId: "shape:cueA", frame: cue("dup", "s1", "a1", "T1") },
      { shapeId: "shape:cueB", frame: cue("dup", "s2", "a2", "T2") },
    ];
    const { doc, getStoredFrame } = makeDoc(entries);
    const plan = planSubFrameAddAfter({
      doc,
      prevShapeId: "shape:cueA",
      getStoredFrame,
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameUpdate).toBeNull();
    expect(plan!.cueFrameId).toBe("dup");
  });
});

describe("planDetachedReattach (shapeId target identity)", () => {
  it("reattaches to a non-representative duplicate-id cue unambiguously (round trip)", () => {
    // shape:cueA is the representative for the ambiguous "dupcue"
    // reference, so the existing sub (key "a5") attaches to ITS batch.
    // Reattaching the orphan onto shape:cueB must freshen cueB's id —
    // referencing "dupcue" would land the orphan on cueA.
    const entries = [
      { shapeId: "shape:cueA", frame: cue("dupcue", "s1", "a1", "T1") },
      { shapeId: "shape:cueB", frame: cue("dupcue", "s2", "a2", "T2") },
      { shapeId: "shape:sub", frame: sub("f-sub", "dupcue", "a5") },
      { shapeId: "shape:orphan", frame: sub("f-orphan", "missing", "a1") },
    ];
    const { doc, getStoredFrame } = makeDoc(entries);
    const plan = planDetachedReattach({
      doc,
      cueShapeId: "shape:cueB",
      getStoredFrame,
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameUpdate).not.toBeNull();
    expect(plan!.cueFrameUpdate!.shapeId).toBe("shape:cueB");
    expect(plan!.cueFrameId).toBe(plan!.cueFrameUpdate!.frame.id);
    expect(plan!.cueFrameId).not.toBe("dupcue");
    // Keys relative to cueB's (empty) batch — a key above "a5" would
    // prove the wrong batch was measured.
    expect(compareOrderKeys(plan!.orderKey, "a5")).toBeLessThan(0);

    // Apply the FULL plan and re-derive: the orphan belongs to the
    // SELECTED cue's batch; the representative keeps its sub and its id.
    const orphanFrame = entries[3].frame as SubFrame;
    const rederived = rederive(entries, [
      plan!.cueFrameUpdate!,
      {
        shapeId: "shape:orphan",
        frame: {
          ...orphanFrame,
          cueFrameId: plan!.cueFrameId,
          orderKey: plan!.orderKey,
        },
      },
    ]);
    expect(rederived.detachedFrames).toEqual([]);
    expect(
      batchOfCueShape(rederived, "shape:cueB")!.frames.map((f) => f.shapeId),
    ).toEqual(["shape:cueB", "shape:orphan"]);
    expect(
      batchOfCueShape(rederived, "shape:cueA")!.frames.map((f) => f.shapeId),
    ).toEqual(["shape:cueA", "shape:sub"]);
    expect(batchOfCueShape(rederived, "shape:cueA")!.frames[0].frameId).toBe(
      "dupcue",
    );
  });

  it("keeps the representative cue's id when reattaching to it", () => {
    const { doc, getStoredFrame } = makeDoc([
      { shapeId: "shape:cueA", frame: cue("dupcue", "s1", "a1", "T1") },
      { shapeId: "shape:cueB", frame: cue("dupcue", "s2", "a2", "T2") },
    ]);
    const plan = planDetachedReattach({
      doc,
      cueShapeId: "shape:cueA",
      getStoredFrame,
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameUpdate).toBeNull();
    expect(plan!.cueFrameId).toBe("dupcue");
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
      mintId: makeMinter(),
    });
    expect(plan).not.toBeNull();
    expect(plan!.cueFrameUpdate).toBeNull();
    expect(compareOrderKeys("a3", plan!.orderKey)).toBeLessThan(0);
  });
});
