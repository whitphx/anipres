import { describe, it, expect } from "vitest";
import { remapContentFrames } from "./duplicate";
import type { RemapContentInput } from "./duplicate";
import { deriveTimeline } from "./derive";
import { SYNTHETIC_STEP_PREFIX } from "./ids";
import { compareOrderKeys } from "./keys";
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
    operation: "external-paste",
    mintId: makeMinter(),
    ...overrides,
  };
}

describe("remapContentFrames — external paste", () => {
  it("keeps foreign non-colliding identities", () => {
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
    expect(result.existingStepKeyUpdates).toEqual([]);
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

  it("remaps colliding stepId/trackId but keeps source order keys (shared ancestry, diverged orders)", () => {
    // Destination has the SAME ids as the source (file-level copy) but a
    // different current order: local s1 was moved after s2.
    const destinationDoc = deriveTimeline({
      shapes: [
        { shapeId: "shape:x", frameMeta: cueMeta("g1", "s1", "a9", "T") },
        { shapeId: "shape:y", frameMeta: cueMeta("g2", "s2", "a1", "U") },
      ],
      pageId: "page:page",
    });
    const result = remapContentFrames(
      makeInput({
        shapes: [
          // Source deck still has s1 first (key a1) and s9 second (a2).
          { shapeId: "copy:a", frameMeta: cueMeta("p1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: cueMeta("p2", "s9", "a2", "V") },
        ],
        existing: {
          frameIds: new Set(["g1", "g2"]),
          stepIds: new Set(["s1", "s2"]),
          trackIds: new Set(["T", "U"]),
        },
        currentDoc: destinationDoc,
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    const b = result.updatedFrames.get("copy:b") as CueFrame;
    // Colliding ids are severed; non-colliding foreign ids are kept.
    expect(a.stepId).not.toBe("s1");
    expect(a.trackId).not.toBe("T");
    expect(b.stepId).toBe("s9");
    expect(b.trackId).toBe("V");
    // Source keys are preserved — the pasted steps keep their own
    // relative order and are NOT repositioned after the colliding local
    // step (which is not their original).
    expect(a.stepOrderKey).toBe("a1");
    expect(b.stepOrderKey).toBe("a2");
    expect(result.existingStepKeyUpdates).toEqual([]);
  });

  it("severs the cue reference of a sub frame pasted alone", () => {
    const result = remapContentFrames(
      makeInput({
        shapes: [{ shapeId: "copy:a", frameMeta: subMeta("f2", "f1", "a0") }],
        existing: {
          // Shared-ancestry destination even contains a frame id "f1" —
          // retaining the reference would attach the paste to an
          // unrelated local cue.
          frameIds: new Set(["f1"]),
          stepIds: new Set(),
          trackIds: new Set(),
        },
      }),
    );
    const sub = result.updatedFrames.get("copy:a") as SubFrame;
    expect(sub.cueFrameId).not.toBe("f1");
    expect(sub.cueFrameId.length).toBeGreaterThan(0);
  });
});

describe("remapContentFrames — within-document duplication", () => {
  it("shares one fresh stepId among copied cues of the same step (grouped duplication)", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
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
        operation: "duplicate",
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

  it("keeps the cue reference when a cue is duplicated together with its sub frames", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    const sub = result.updatedFrames.get("copy:b") as SubFrame;
    expect(sub.cueFrameId).toBe(cue.id);
  });

  it("severs the cue reference when a sub frame is duplicated alone", () => {
    // Retaining the original cueFrameId would re-attach the duplicate to
    // the original cue's batch.
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [{ shapeId: "copy:a", frameMeta: subMeta("f2", "f1", "a0") }],
        existing: {
          frameIds: new Set(["f1", "f2"]),
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const sub = result.updatedFrames.get("copy:a") as SubFrame;
    expect(sub.cueFrameId).not.toBe("f1");
  });

  it("places a duplicated step directly after its original", () => {
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a5", "U") },
      ],
      pageId: "page:page",
    });
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
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
    expect(compareOrderKeys(cue.stepOrderKey, "a1")).toBeGreaterThan(0);
    expect(compareOrderKeys(cue.stepOrderKey, "a5")).toBeLessThan(0);
    expect(result.existingStepKeyUpdates).toEqual([]);
  });

  it("normalizes the local equal-key run when duplicating inside one", () => {
    // Steps s1 and s2 collided on key "a1" (concurrent inserts).
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a1", "U") },
        { shapeId: "shape:c", frameMeta: cueMeta("f3", "s3", "a5", "V") },
      ],
      pageId: "page:page",
    });
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2", "f3"]),
          stepIds: new Set(["s1", "s2", "s3"]),
          trackIds: new Set(["T", "U", "V"]),
        },
        currentDoc: doc,
      }),
    );
    const inserted = result.updatedFrames.get("copy:a") as CueFrame;
    // The equal-key run had to be re-keyed to make room; the rewrites are
    // returned so the caller applies them in the SAME transaction.
    expect(result.existingStepKeyUpdates.length).toBeGreaterThan(0);
    // Resulting order: s1 < inserted copy < s2 < s3, all keys distinct.
    const keyOf = new Map(
      result.existingStepKeyUpdates.map((u) => [u.stepId, u.key]),
    );
    const s1Key = keyOf.get("s1") ?? "a1";
    const s2Key = keyOf.get("s2") ?? "a1";
    const s3Key = keyOf.get("s3") ?? "a5";
    expect(compareOrderKeys(s1Key, inserted.stepOrderKey)).toBeLessThan(0);
    expect(compareOrderKeys(inserted.stepOrderKey, s2Key)).toBeLessThan(0);
    expect(compareOrderKeys(s2Key, s3Key)).toBeLessThan(0);
  });
});

describe("remapContentFrames — orphan sub-frame relationships", () => {
  // Severed references must still preserve the grouping AMONG the copies:
  // one shared fresh unresolved id per absent source cue.

  it("gives sub frames that shared one omitted cue the same fresh unresolved id", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [
          { shapeId: "copy:a", frameMeta: subMeta("f2", "f1", "a0") },
          { shapeId: "copy:b", frameMeta: subMeta("f3", "f1", "a1") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2", "f3"]),
          stepIds: new Set(),
          trackIds: new Set(),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as SubFrame;
    const b = result.updatedFrames.get("copy:b") as SubFrame;
    expect(a.cueFrameId).not.toBe("f1"); // severed from the source cue
    expect(a.cueFrameId).toBe(b.cueFrameId); // …but still grouped together
  });

  it("gives sub frames of different omitted cues different fresh unresolved ids", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [
          { shapeId: "copy:a", frameMeta: subMeta("f3", "f1", "a0") },
          { shapeId: "copy:b", frameMeta: subMeta("f4", "f2", "a0") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2", "f3", "f4"]),
          stepIds: new Set(),
          trackIds: new Set(),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as SubFrame;
    const b = result.updatedFrames.get("copy:b") as SubFrame;
    expect(a.cueFrameId).not.toBe(b.cueFrameId);
  });

  it("produces the same relationship structure for reversed input order", () => {
    const shapes = [
      { shapeId: "copy:a", frameMeta: subMeta("f3", "f1", "a0") },
      { shapeId: "copy:b", frameMeta: subMeta("f4", "f1", "a1") },
      { shapeId: "copy:c", frameMeta: subMeta("f5", "f2", "a0") },
    ];
    const existing = {
      frameIds: new Set(["f1", "f2", "f3", "f4", "f5"]),
      stepIds: new Set<string>(),
      trackIds: new Set<string>(),
    };
    const r1 = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes,
        existing,
        mintId: makeMinter(),
      }),
    );
    const r2 = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [...shapes].reverse(),
        existing,
        mintId: makeMinter(),
      }),
    );
    expect([...r2.updatedFrames.entries()]).toEqual([
      ...r1.updatedFrames.entries(),
    ]);
    const a = r1.updatedFrames.get("copy:a") as SubFrame;
    const b = r1.updatedFrames.get("copy:b") as SubFrame;
    const c = r1.updatedFrames.get("copy:c") as SubFrame;
    expect(a.cueFrameId).toBe(b.cueFrameId);
    expect(a.cueFrameId).not.toBe(c.cueFrameId);
  });

  it("still remaps to the copied cue when it IS part of the operation", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
          // References an omitted cue — must NOT be lumped in with f1's.
          { shapeId: "copy:c", frameMeta: subMeta("f3", "f9", "a0") },
        ],
        existing: {
          frameIds: new Set(["f1", "f2", "f3", "f9"]),
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    const attached = result.updatedFrames.get("copy:b") as SubFrame;
    const orphan = result.updatedFrames.get("copy:c") as SubFrame;
    expect(attached.cueFrameId).toBe(cue.id); // copied-cue remap wins
    expect(orphan.cueFrameId).not.toBe(cue.id);
    expect(orphan.cueFrameId).not.toBe("f9");
  });
});

describe("remapContentFrames — shared behavior", () => {
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

  it("freshens reserved-prefix step ids into normal ids (paste-mode parsing)", () => {
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
    const cue = result.updatedFrames.get("copy:a") as CueFrame;
    expect(cue).toBeTruthy();
    expect(cue.stepId.startsWith(SYNTHETIC_STEP_PREFIX)).toBe(false);
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
      makeInput({
        operation: "duplicate",
        shapes,
        existing,
        mintId: makeMinter(),
      }),
    );
    const r2 = remapContentFrames(
      makeInput({
        operation: "duplicate",
        shapes: [...shapes].reverse(),
        existing,
        mintId: makeMinter(),
      }),
    );
    expect([...r2.updatedFrames.entries()]).toEqual([
      ...r1.updatedFrames.entries(),
    ]);
    expect(r2.existingStepKeyUpdates).toEqual(r1.existingStepKeyUpdates);
  });
});

describe("remapContentFrames — same-document move (cut + paste)", () => {
  // move = restore the same logical animation objects after a cut.
  // Identities and relationships are preserved so pasted shapes rejoin
  // uncut members of their original steps, tracks, and batches.

  it("keeps the shared stepId when only part of a simultaneous step was cut (round trip)", () => {
    // Cues A and B shared stepId s1; only A was cut. B remains.
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        ],
        existing: {
          frameIds: new Set(["f2"]),
          stepIds: new Set(["s1"]), // B still owns s1 — the rejoin target
          trackIds: new Set(["U"]),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    expect(a).toEqual(cueMeta("f1", "s1", "a1", "T")); // fully preserved
    expect(result.existingStepKeyUpdates).toEqual([]);

    // Re-derive with the remaining cue B: A and B are simultaneous again.
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:b", frameMeta: cueMeta("f2", "s1", "a1", "U") },
        { shapeId: "shape:pasted", frameMeta: a },
      ],
      pageId: "page:page",
    });
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].batches).toHaveLength(2);
    expect(doc.diagnostics).toEqual([]);
  });

  it("keeps the trackId when only part of a track was cut (round trip)", () => {
    // Cues A (step s1) and B (step s2) share track T; only A was cut.
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
        ],
        existing: {
          frameIds: new Set(["f2"]),
          stepIds: new Set(["s2"]),
          trackIds: new Set(["T"]), // B still animates on T
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    expect(a).toEqual(cueMeta("f1", "s1", "a1", "T"));

    // Re-derive with the remaining cue B: one two-step sequence on T.
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:b", frameMeta: cueMeta("f2", "s2", "a2", "T") },
        { shapeId: "shape:pasted", frameMeta: a },
      ],
      pageId: "page:page",
    });
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[0].batches[0].trackId).toBe("T");
    expect(doc.steps[1].batches[0].trackId).toBe("T");
  });

  it("keeps cueFrameId and order for sub frames cut without their cue (round trip)", () => {
    // The cue and one sub remain; two subs were cut and pasted back.
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: [
          { shapeId: "copy:y", frameMeta: subMeta("f-y", "c1", "a3") },
          { shapeId: "copy:x", frameMeta: subMeta("f-x", "c1", "a2") },
        ],
        existing: {
          frameIds: new Set(["c1", "f-s0"]),
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const x = result.updatedFrames.get("copy:x") as SubFrame;
    const y = result.updatedFrames.get("copy:y") as SubFrame;
    expect(x).toEqual(subMeta("f-x", "c1", "a2")); // reference NOT severed
    expect(y).toEqual(subMeta("f-y", "c1", "a3"));

    // Re-derive with the remaining cue and sub: the moved subs reattach
    // to the original batch in their original order — not detached.
    const doc = deriveTimeline({
      shapes: [
        { shapeId: "shape:c", frameMeta: cueMeta("c1", "s1", "a1", "T") },
        { shapeId: "shape:s0", frameMeta: subMeta("f-s0", "c1", "a1") },
        { shapeId: "shape:x", frameMeta: x },
        { shapeId: "shape:y", frameMeta: y },
      ],
      pageId: "page:page",
    });
    expect(doc.detachedFrames).toEqual([]);
    expect(doc.steps[0].batches[0].frames.map((f) => f.frameId)).toEqual([
      "c1",
      "f-s0",
      "f-x",
      "f-y",
    ]);
  });

  it("preserves a complete self-contained sequence byte-for-byte", () => {
    // A whole sequence (cue + subs) was cut; nothing of it remains.
    const source = [
      { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
      { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
      { shapeId: "copy:c", frameMeta: subMeta("f3", "f1", "a1") },
    ];
    const currentDoc = deriveTimeline({
      shapes: [
        { shapeId: "shape:other", frameMeta: cueMeta("g1", "s9", "a9", "V") },
      ],
      pageId: "page:page",
    });
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: source,
        existing: {
          frameIds: new Set(["g1"]),
          stepIds: new Set(["s9"]),
          trackIds: new Set(["V"]),
        },
        currentDoc, // present, but a move must NOT run placement
      }),
    );
    expect(result.updatedFrames.get("copy:a")).toEqual(
      cueMeta("f1", "s1", "a1", "T"),
    );
    expect(result.updatedFrames.get("copy:b")).toEqual(
      subMeta("f2", "f1", "a0"),
    );
    expect(result.updatedFrames.get("copy:c")).toEqual(
      subMeta("f3", "f1", "a1"),
    );
    expect(result.existingStepKeyUpdates).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("freshens a genuinely colliding frame.id instead of silently joining the live record", () => {
    // Residual conflict: sync (or partial deletion) left a LIVE record
    // with the moved cue's frame.id. The id is freshened exactly as in an
    // external paste; the moved sub follows its cue via the remap, and
    // step/track identities are still preserved.
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: [
          { shapeId: "copy:a", frameMeta: cueMeta("f1", "s1", "a1", "T") },
          { shapeId: "copy:b", frameMeta: subMeta("f2", "f1", "a0") },
        ],
        existing: {
          frameIds: new Set(["f1"]), // conflicting live record
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const a = result.updatedFrames.get("copy:a") as CueFrame;
    const b = result.updatedFrames.get("copy:b") as SubFrame;
    expect(a.id).not.toBe("f1"); // no silent join
    expect(a.stepId).toBe("s1"); // rejoin semantics otherwise intact
    expect(a.trackId).toBe("T");
    expect(b.cueFrameId).toBe(a.id); // sub follows its moved cue
  });

  it("keeps the cue reference of a moved sub even when its own id collides", () => {
    const result = remapContentFrames(
      makeInput({
        operation: "move",
        shapes: [{ shapeId: "copy:a", frameMeta: subMeta("f2", "c1", "a2") }],
        existing: {
          frameIds: new Set(["f2", "c1"]), // own id collides; cue remains
          stepIds: new Set(["s1"]),
          trackIds: new Set(["T"]),
        },
      }),
    );
    const moved = result.updatedFrames.get("copy:a") as SubFrame;
    expect(moved.id).not.toBe("f2"); // freshened against the live record
    expect(moved.cueFrameId).toBe("c1"); // still rejoins the original batch
    expect(moved.orderKey).toBe("a2");
  });
});
