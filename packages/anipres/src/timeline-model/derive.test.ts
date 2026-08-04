import { describe, it, expect } from "vitest";
import { deriveTimeline } from "./derive";
import { orderKeysBetween } from "./order-key";
import { makeSyntheticStepId, SYNTHETIC_STEP_PREFIX } from "./ids";
import type { CueFrame, SubFrame } from "./types";

function cueMeta(
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

function subMeta(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return {
    v: 2,
    id,
    type: "sub",
    cueFrameId,
    orderKey,
    action: { type: "shapeAnimation" },
  };
}

function derive(shapes: { shapeId: string; frameMeta: unknown }[]) {
  return deriveTimeline({ shapes });
}

describe("deriveTimeline", () => {
  it("orders steps by (canonical stepOrderKey, stepId) and groups by stepId", () => {
    const doc = derive([
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "step2", "a2", "T2") },
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "step1", "a1", "T1") },
      { shapeId: "shape:c", frameMeta: cueMeta("f3", "step1", "a1", "T3") },
    ]);
    expect(doc.steps.map((s) => s.id)).toEqual(["step1", "step2"]);
    expect(doc.steps[0].batches).toHaveLength(2);
    expect(doc.diagnostics).toEqual([]);
  });

  it("keeps concurrently inserted steps separate on key collision (distinct stepIds)", () => {
    const doc = derive([
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "stepA", "a1", "T1") },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "stepB", "a1", "T2") },
    ]);
    expect(doc.steps.map((s) => s.id)).toEqual(["stepA", "stepB"]);
    expect(doc.steps).toHaveLength(2);
  });

  it("is independent of input iteration order", () => {
    const shapes = [
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T1") },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a2", "T2") },
      { shapeId: "shape:c", frameMeta: subMeta("f3", "f1", "a0") },
    ];
    const doc1 = derive(shapes);
    const doc2 = derive([...shapes].reverse());
    expect(doc2).toEqual(doc1);
  });

  // Rule 1: divergent stepOrderKey within one stepId.
  it("canonicalizes divergent step keys via the smallest-frame-id representative", () => {
    const doc = derive([
      // representative = f1 (smallest frame id) with key a5
      { shapeId: "shape:b", frameMeta: cueMeta("f1", "s1", "a5", "T1") },
      { shapeId: "shape:a", frameMeta: cueMeta("f2", "s1", "a1", "T2") },
      { shapeId: "shape:c", frameMeta: cueMeta("f3", "s2", "a3", "T3") },
    ]);
    // canonical key of s1 is a5 (f1's), so s2 (a3) comes first
    expect(doc.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(doc.steps[1].batches).toHaveLength(2); // all members stay in the step
    expect(doc.diagnostics).toContainEqual({
      type: "step-key-divergence",
      stepId: "s1",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  // Rule 2: same track twice within one step → synthetic split.
  it("splits same-track duplicates into synthetic steps with StepData.synthetic set", () => {
    const doc = derive([
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "s1", "a1", "T") },
      { shapeId: "shape:c", frameMeta: cueMeta("f3", "s2", "a2", "U") },
    ]);
    expect(doc.steps).toHaveLength(3);
    expect(doc.steps[0].id).toBe("s1");
    expect(doc.steps[0].batches[0].frames[0].frameId).toBe("f1");
    const synthetic = doc.steps[1];
    expect(synthetic.id).toBe(makeSyntheticStepId("s1", "shape:b"));
    expect(synthetic.synthetic).toEqual({
      reason: "same-track-split",
      sourceStepId: "s1",
    });
    expect(synthetic.batches[0].frames[0].frameId).toBe("f2");
    expect(doc.steps[2].id).toBe("s2");
    expect(doc.diagnostics).toContainEqual({
      type: "same-track-split",
      stepId: "s1",
      trackId: "T",
      shapeIds: ["shape:b"],
    });
  });

  it("gives each split batch its own synthetic step, deterministically and stably", () => {
    const shapes = [
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "s1", "a1", "T") },
      { shapeId: "shape:c", frameMeta: cueMeta("f3", "s1", "a1", "T") },
    ];
    const doc1 = derive(shapes);
    const doc2 = derive([...shapes].reverse());
    expect(doc1.steps).toHaveLength(3);
    expect(doc1.steps.map((s) => s.id)).toEqual(doc2.steps.map((s) => s.id));
    expect(doc1.steps[1].id.startsWith(SYNTHETIC_STEP_PREFIX)).toBe(true);
    expect(doc1.steps[1].id).not.toBe(doc1.steps[2].id);
  });

  // Rule 3: dangling cueFrameId → detached, surfaced, never dropped.
  it("surfaces sub frames with dangling cueFrameId as detached", () => {
    const doc = derive([
      { shapeId: "shape:a", frameMeta: subMeta("f1", "missing", "a0") },
    ]);
    expect(doc.steps).toEqual([]);
    expect(doc.detachedFrames).toEqual([
      { frameId: "f1", shapeId: "shape:a", action: { type: "shapeAnimation" } },
    ]);
    expect(doc.diagnostics).toContainEqual({
      type: "detached-sub-frame",
      shapeId: "shape:a",
      cueFrameId: "missing",
    });
  });

  // Rule 4: duplicate frame ids — lossless, keyed on shapeId.
  it("keeps all shapes under duplicate frame ids and attaches ambiguous subs to the representative", () => {
    const doc = derive([
      { shapeId: "shape:b", frameMeta: cueMeta("dup", "s1", "a1", "T1") },
      { shapeId: "shape:a", frameMeta: cueMeta("dup", "s2", "a2", "T2") },
      { shapeId: "shape:c", frameMeta: subMeta("f3", "dup", "a0") },
    ]);
    const allShapeIds = doc.steps.flatMap((s) =>
      s.batches.flatMap((b) => b.frames.map((f) => f.shapeId)),
    );
    expect(allShapeIds).toContain("shape:a");
    expect(allShapeIds).toContain("shape:b");
    expect(allShapeIds).toContain("shape:c");
    // The sub attaches to the representative (smallest shape id = shape:a).
    const stepWithSub = doc.steps.find((s) =>
      s.batches.some((b) => b.frames.some((f) => f.frameId === "f3")),
    );
    expect(stepWithSub?.batches[0].frames[0].shapeId).toBe("shape:a");
    expect(doc.diagnostics).toContainEqual({
      type: "duplicate-frame-id",
      frameId: "dup",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  it("orders sub frames within a batch by (orderKey, id)", () => {
    const doc = derive([
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "shape:c", frameMeta: subMeta("f3", "f1", "a2") },
      { shapeId: "shape:b", frameMeta: subMeta("f2", "f1", "a1") },
    ]);
    expect(doc.steps[0].batches[0].frames.map((f) => f.frameId)).toEqual([
      "f1",
      "f2",
      "f3",
    ]);
  });

  it("emits invalid-frame diagnostics for malformed metadata without throwing", () => {
    const doc = derive([
      { shapeId: "shape:a", frameMeta: { v: 2, type: "cue" } }, // missing fields
      { shapeId: "shape:b", frameMeta: "garbage" },
      { shapeId: "shape:c", frameMeta: null }, // none — no diagnostic
      { shapeId: "shape:d", frameMeta: cueMeta("f1", "s1", "a1", "T") },
    ]);
    expect(doc.steps).toHaveLength(1);
    expect(doc.diagnostics).toContainEqual({
      type: "invalid-frame",
      shapeId: "shape:a",
    });
    expect(doc.diagnostics).toContainEqual({
      type: "invalid-frame",
      shapeId: "shape:b",
    });
    expect(
      doc.diagnostics.filter((d) => d.type === "invalid-frame"),
    ).toHaveLength(2);
  });

  it("diagnoses a persisted stepId carrying the reserved synthstep: prefix as invalid", () => {
    const doc = derive([
      {
        shapeId: "shape:a",
        frameMeta: cueMeta(
          "f1",
          `${SYNTHETIC_STEP_PREFIX}["x","y"]`,
          "a1",
          "T",
        ),
      },
    ]);
    expect(doc.steps).toEqual([]);
    expect(doc.diagnostics).toContainEqual({
      type: "invalid-frame",
      shapeId: "shape:a",
    });
  });

  it("surfaces v1 records as diagnostics instead of animating them", () => {
    // Read-time v1 conversion was removed after the one-time batch
    // migration of all known documents (design doc r9).
    const doc = derive([
      {
        shapeId: "shape:a",
        frameMeta: {
          id: "f1",
          type: "cue",
          globalIndex: 0,
          trackId: "T",
          action: { type: "shapeAnimation" },
        },
      },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a9", "U") },
    ]);
    // Only the v2 record derives; the v1 record is surfaced, not lost.
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].id).toBe("s2");
    expect(doc.diagnostics).toEqual([
      { type: "v1-frame", shapeIds: ["shape:a"] },
    ]);
  });

  it("aggregates every v1 record into one diagnostic, sorted and input-order independent", () => {
    const v1 = (shapeId: string, frameId: string, globalIndex: number) => ({
      shapeId,
      frameMeta: {
        id: frameId,
        type: "cue",
        globalIndex,
        trackId: "T",
        action: { type: "shapeAnimation" },
      },
    });
    const entries = [v1("shape:c", "f3", 2), v1("shape:a", "f1", 0)];
    const expected = [{ type: "v1-frame", shapeIds: ["shape:a", "shape:c"] }];
    expect(derive(entries).diagnostics).toEqual(expected);
    expect(derive([...entries].reverse()).diagnostics).toEqual(expected);
  });
});

describe("makeSyntheticStepId", () => {
  it("is injective for components containing colons", () => {
    expect(makeSyntheticStepId("a:b", "c")).not.toBe(
      makeSyntheticStepId("a", "b:c"),
    );
  });

  it("is deterministic and distinct for distinct pairs", () => {
    expect(makeSyntheticStepId("s", "x")).toBe(makeSyntheticStepId("s", "x"));
    expect(makeSyntheticStepId("s", "x")).not.toBe(
      makeSyntheticStepId("s", "y"),
    );
  });
});

// Regression guard: fractional keys generated BEFORE the first item are
// capital-prefixed (e.g. the key below "a0" is "Zz"), and only plain
// code-unit comparison sorts them correctly — String#localeCompare puts
// "Zz" AFTER "a0". These tests assert via the full derivation so they
// fail if any future sort site regresses to localeCompare.
describe("before-first key ordering (capital-prefixed keys)", () => {
  it("derives a step keyed below the previous first step as the new first step", () => {
    // "a0" is the lowest integer key; the key below it is capital-prefixed.
    const [belowKey] = orderKeysBetween(null, "a0", 1);
    // The premise this guards: before-first keys are capital-prefixed and
    // mis-sort under locale comparison.
    expect(belowKey < "a0").toBe(true);
    expect(belowKey.localeCompare("a0")).toBeGreaterThan(0);

    const doc = derive([
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a0", "T") },
      { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", belowKey, "U") },
    ]);
    expect(doc.steps.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("derives a sub frame keyed below its batch's first sub frame first", () => {
    const [belowKey] = orderKeysBetween(null, "a0", 1);
    const doc = derive([
      { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "shape:b", frameMeta: subMeta("f2", "f1", "a0") },
      { shapeId: "shape:c", frameMeta: subMeta("f3", "f1", belowKey) },
    ]);
    expect(doc.steps[0].batches[0].frames.map((f) => f.frameId)).toEqual([
      "f1",
      "f3",
      "f2",
    ]);
  });
});
