import { describe, it, expect } from "vitest";
import { remapContentFrames } from "./duplicate";
import type { RemapContentInput } from "./duplicate";
import { deriveTimeline } from "./derive";
import { SYNTHETIC_STEP_PREFIX } from "./ids";
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

function makeMinter(prefix = "fresh") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeInput(
  overrides: Partial<RemapContentInput> = {},
): RemapContentInput {
  return {
    shapes: [],
    existing: {
      frameIds: new Set<string>(),
      stepIds: new Set<string>(),
      trackIds: new Set<string>(),
    },
    currentDoc: null,
    mintId: makeMinter(),
    ...overrides,
  };
}

describe("remapContentFrames", () => {
  it("keeps foreign non-colliding identities (cross-document paste)", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
        ],
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    const sub = result.updatedFrames.get("copy:b") as SubFrame;
    expect(cue.id).toBe("f1");
    expect(cue.stepId).toBe("s1");
    expect(cue.trackId).toBe("T");
    expect(sub.cueFrameId).toBe("f1");
  });

  it("freshens colliding frame ids and remaps cueFrameId through the copies", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(),
          trackIds: new Set(),
        },
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    const sub = result.updatedFrames.get("copy:b") as SubFrame;
    expect(cue.id).not.toBe("f1");
    expect(sub.id).not.toBe("f2");
    expect(sub.cueFrameId).toBe(cue.id); // relationship preserved
  });

  it("shares one fresh stepId among copied cues of the same step (grouped duplication)", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: cueMeta("f2", "s1", "a1", "U") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(["s1"]),
          trackIds: new Set(),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    const b = result.updatedFrames.get("copy:b") as CueFrame;
    expect(a.stepId).not.toBe("s1"); // does not join the original step
    expect(a.stepId).toBe(b.stepId); // copies stay simultaneous
    expect(a.stepOrderKey).toBe(b.stepOrderKey);
  });

  it("shares one fresh trackId among copies of the same track (copied sequences still animate)", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: cueMeta("f2", "s2", "a2", "T") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(["s1", "s2"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    const b = result.updatedFrames.get("copy:b") as CueFrame;
    expect(a.trackId).not.toBe("T"); // severed from the original track
    expect(a.trackId).toBe(b.trackId); // but shared among the copies
    expect(a.stepId).not.toBe(b.stepId); // distinct steps stay distinct
  });

  it("remaps a colliding foreign trackId on shared-ancestry cross-document paste", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f9", "s9", "a1", "T") },
        ],
        existing: {
          frameIds: new Set(),
          stepIds: new Set(),
          trackIds: new Set(["T"]), // same ancestry → identical track ids
        },
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    expect(cue.trackId).not.toBe("T");
  });

  it("places a within-document duplicated step directly after its original", () => {
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a5", "U") },
      ],
      pageId: "page:page",
    });
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(["s1", "s2"]),
          trackIds: new Set(["T", "U"]),
        },
        currentDoc: doc,
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    expect(cue.stepOrderKey > "a1").toBe(true);
    expect(cue.stepOrderKey < "a5").toBe(true);
  });

  it("is lossless under duplicate source frame ids (distinct fresh ids per copy)", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          { shapeId: "copy:b", frameMeta: cueMeta("dup", "s1", "a1", "T") },
          { shapeId: "copy:a", frameMeta: cueMeta("dup", "s2", "a2", "U") },
          { shapeId: "copy:c", frameMeta: subMeta("f3", "dup", "a0") },
        ],
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    const b = result.updatedFrames.get("copy:b") as CueFrame;
    const sub = result.updatedFrames.get("copy:c") as SubFrame;
    expect(a.id).not.toBe(b.id); // copies get distinct fresh ids
    // Ambiguous reference resolves to the representative (smallest shape id).
    expect(sub.cueFrameId).toBe(a.id);
    expect(result.diagnostics).toContainEqual({
      type: "ambiguous-cue-reference",
      frameId: "dup",
    });
  });

  it("always freshens reserved-prefix step ids", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [
          {
            shapeId: "copy:a",
            frameMeta: {
              ...cueMeta("f1", "placeholder", "a1", "T"),
              stepId: `${SYNTHETIC_STEP_PREFIX}["s","x"]`,
            },
          },
        ],
      }),
    );
    // A reserved-prefix stepId fails v2 parsing (parser diagnoses it), so
    // the frame passes through untouched for the destination's derivation
    // to diagnose — it must NOT come out carrying the reserved id as a
    // fresh valid frame.
    expect(result.updatedFrames.size).toBe(0);
  });

  it("is order-independent (permuted input → identical output)", () => {
    const shapes = [
      { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "copy:b", frameMeta: cueMeta("f2", "s1", "a1", "U") },
      { shapeId: "copy:c", frameMeta: subMeta("f3", "f1", "a0") },
    ];
    const existing = {
      frameIds: new Set(["f1", "f2", "f3"]),
      stepIds: new Set(["s1"]),
      trackIds: new Set(["T", "U"]),
    };
    const r1 = remapContentFrames(
      makeInput({ shapes, existing, mintId: makeMinter() }),
    );
    const r2 = remapContentFrames(
      makeInput({
        shapes: [...shapes].reverse(),
        existing,
        mintId: makeMinter(),
      }),
    );
    expect([...r2.updatedFrames.entries()]).toEqual([
      ...r1.updatedFrames.entries(),
    ]);
  });
});
