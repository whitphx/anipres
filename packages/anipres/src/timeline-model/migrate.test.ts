import { describe, it, expect } from "vitest";
import { migrateV1Frames } from "./migrate";
import type { ShapeLegacyFrame, ShapeV2Frame } from "./migrate";
import { makeMigratedStepId, parseMigratedStepId } from "./ids";
import {
  deterministicKeysBetween,
  getMigratedStepOrderKey,
  getMigratedSubFrameOrderKey,
} from "./keys";
import type { LegacyCueFrame, LegacySubFrame } from "./parse";
import type { CueFrame } from "./types";

const PAGE_ID = "page:xyz"; // page ids contain ":" — exercised on purpose

function v1Cue(
  id: string,
  globalIndex: number,
  trackId: string,
): LegacyCueFrame {
  return {
    id,
    type: "cue",
    globalIndex,
    trackId,
    action: { type: "shapeAnimation" },
  };
}

function v1Sub(id: string, prevFrameId: string): LegacySubFrame {
  return { id, type: "sub", prevFrameId, action: { type: "shapeAnimation" } };
}

describe("v1step: id parse contract", () => {
  it("round-trips page ids containing colons", () => {
    const id = makeMigratedStepId("page:xyz", 4, 1);
    expect(parseMigratedStepId(id)).toEqual({
      pageId: "page:xyz",
      globalIndex: 4,
      partitionIndex: 1,
    });
  });

  it("rejects non-contract ids", () => {
    expect(parseMigratedStepId("v1step:page:xyz:4")).toBeNull(); // too few segments... p missing
    expect(parseMigratedStepId("v1step:page:a:b")).toBeNull();
    expect(parseMigratedStepId("other:page:1:2")).toBeNull();
  });
});

describe("getMigratedStepOrderKey", () => {
  it("is pinned to literal key strings (Risk 5: sequence must never change)", () => {
    expect(getMigratedStepOrderKey(0, 0)).toBe("a0");
    expect(getMigratedStepOrderKey(1, 0)).toBe("a1");
    expect(getMigratedStepOrderKey(4, 0)).toBe("a4");
    expect(getMigratedStepOrderKey(4, 1)).toBe("a4V");
    expect(getMigratedStepOrderKey(4, 2)).toBe("a4k");
  });

  it("is a pure function preserving (globalIndex, partition) order", () => {
    const keys = [
      getMigratedStepOrderKey(0, 0),
      getMigratedStepOrderKey(1, 0),
      getMigratedStepOrderKey(1, 1),
      getMigratedStepOrderKey(1, 2),
      getMigratedStepOrderKey(2, 0),
    ];
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
    // Pure: repeated calls, any order.
    expect(getMigratedStepOrderKey(1, 1)).toBe(keys[2]);
    expect(getMigratedStepOrderKey(0, 0)).toBe(keys[0]);
  });
});

describe("migrateV1Frames", () => {
  it("stamps one deterministic (stepId, stepOrderKey) pair per partition", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 0, "T") },
      { shapeId: "shape:b", frame: v1Cue("f2", 0, "U") }, // simultaneous
      { shapeId: "shape:c", frame: v1Cue("f3", 1, "T") },
    ];
    const result = migrateV1Frames(input, [], PAGE_ID);
    const byShape = new Map(result.updates.map((u) => [u.shapeId, u.frame]));
    const a = byShape.get("shape:a") as CueFrame;
    const b = byShape.get("shape:b") as CueFrame;
    const c = byShape.get("shape:c") as CueFrame;
    expect(a.stepId).toBe(makeMigratedStepId(PAGE_ID, 0, 0));
    expect(b.stepId).toBe(a.stepId); // v1 simultaneity survives
    expect(b.stepOrderKey).toBe(a.stepOrderKey);
    expect(c.stepId).toBe(makeMigratedStepId(PAGE_ID, 1, 0));
    expect(a.stepOrderKey < c.stepOrderKey).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("is deterministic across runs and input orders (byte-identical)", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 0, "T") },
      { shapeId: "shape:b", frame: v1Cue("f2", 0, "T") }, // conflict → partition
      { shapeId: "shape:c", frame: v1Sub("f3", "f1") },
    ];
    const r1 = migrateV1Frames(input, [], PAGE_ID);
    const r2 = migrateV1Frames([...input].reverse(), [], PAGE_ID);
    expect(JSON.stringify(r2.updates)).toBe(JSON.stringify(r1.updates));
  });

  it("partitions same-track/same-globalIndex conflicts into distinct adjacent steps", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 4, "T") },
      { shapeId: "shape:b", frame: v1Cue("f2", 4, "T") },
      { shapeId: "shape:c", frame: v1Cue("f3", 5, "U") },
    ];
    const result = migrateV1Frames(input, [], PAGE_ID);
    const byShape = new Map(result.updates.map((u) => [u.shapeId, u.frame]));
    const a = byShape.get("shape:a") as CueFrame; // f1 < f2 → partition 0
    const b = byShape.get("shape:b") as CueFrame;
    const c = byShape.get("shape:c") as CueFrame;
    expect(a.stepId).toBe(makeMigratedStepId(PAGE_ID, 4, 0));
    expect(b.stepId).toBe(makeMigratedStepId(PAGE_ID, 4, 1));
    // Partition keys nest strictly between the group and the next group.
    expect(a.stepOrderKey < b.stepOrderKey).toBe(true);
    expect(b.stepOrderKey < c.stepOrderKey).toBe(true);
    expect(result.diagnostics).toContainEqual({
      type: "conflict-partitioned",
      globalIndex: 4,
      trackId: "T",
      shapeIds: ["shape:b"],
    });
  });

  it("resume test: migration interrupted mid-conflict resumes to the identical assignment", () => {
    const full: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 4, "T") },
      { shapeId: "shape:b", frame: v1Cue("f2", 4, "T") },
    ];
    const complete = migrateV1Frames(full, [], PAGE_ID);
    const completeByShape = new Map(
      complete.updates.map((u) => [u.shapeId, u.frame]),
    );

    // Interruption: only shape:a's write persisted. Resume converts only
    // shape:b, reconstructing the group from the persisted v2 record.
    const persisted: ShapeV2Frame[] = [
      { shapeId: "shape:a", frame: completeByShape.get("shape:a")! },
    ];
    const resumed = migrateV1Frames(
      [{ shapeId: "shape:b", frame: v1Cue("f2", 4, "T") }],
      persisted,
      PAGE_ID,
    );
    expect(resumed.updates).toHaveLength(1);
    expect(resumed.updates[0].frame).toEqual(completeByShape.get("shape:b"));
  });

  it("reserves persisted partitions including track occupancy during reconstruction", () => {
    // Persisted: f2 landed in partition 0 (e.g. it sorted first in the
    // original complete run). Remaining v1 cue of the same track must go
    // to partition 1, not re-claim partition 0.
    const persisted: ShapeV2Frame[] = [
      {
        shapeId: "shape:b",
        frame: {
          v: 2,
          id: "f0", // sorts before f1 → complete run gave it partition 0
          type: "cue",
          trackId: "T",
          stepId: makeMigratedStepId(PAGE_ID, 4, 0),
          stepOrderKey: getMigratedStepOrderKey(4, 0),
          action: { type: "shapeAnimation" },
        },
      },
    ];
    const resumed = migrateV1Frames(
      [{ shapeId: "shape:a", frame: v1Cue("f1", 4, "T") }],
      persisted,
      PAGE_ID,
    );
    const migrated = resumed.updates[0].frame as CueFrame;
    expect(migrated.stepId).toBe(makeMigratedStepId(PAGE_ID, 4, 1));
  });

  it("keeps and diagnoses degenerate persisted partitions without rewriting them", () => {
    const makePersisted = (shapeId: string, frameId: string): ShapeV2Frame => ({
      shapeId,
      frame: {
        v: 2,
        id: frameId,
        type: "cue",
        trackId: "T",
        stepId: makeMigratedStepId(PAGE_ID, 4, 0),
        stepOrderKey: getMigratedStepOrderKey(4, 0),
        action: { type: "shapeAnimation" },
      },
    });
    const result = migrateV1Frames(
      [],
      [makePersisted("shape:a", "f1"), makePersisted("shape:b", "f2")],
      PAGE_ID,
    );
    expect(result.updates).toEqual([]); // never rewrites persisted records
    expect(result.diagnostics).toContainEqual({
      type: "degenerate-persisted-partition",
      stepId: makeMigratedStepId(PAGE_ID, 4, 0),
      trackId: "T",
    });
  });

  it("keeps all forks of a forked sub chain as batch members", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 0, "T") },
      { shapeId: "shape:b", frame: v1Sub("f2", "f1") },
      { shapeId: "shape:c", frame: v1Sub("f3", "f1") }, // fork
    ];
    const result = migrateV1Frames(input, [], PAGE_ID);
    const subs = result.updates.filter((u) => u.frame.type === "sub");
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect((sub.frame as { cueFrameId: string }).cueFrameId).toBe("f1");
    }
    const keys = subs.map((s) => (s.frame as { orderKey: string }).orderKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(result.diagnostics.some((d) => d.type === "forked-sub-chain")).toBe(
      true,
    );
  });

  it("migrates dangling sub chains as detached (representable) frames", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Sub("f2", "missing") },
    ];
    const result = migrateV1Frames(input, [], PAGE_ID);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].frame).toMatchObject({
      type: "sub",
      cueFrameId: "missing",
    });
    expect(result.detachedFrames).toHaveLength(1);
    expect(result.diagnostics).toContainEqual({
      type: "dangling-sub-chain",
      shapeId: "shape:a",
      missingFrameId: "missing",
    });
  });

  it("resolves sub chains whose head is an already-migrated v2 cue", () => {
    const persisted: ShapeV2Frame[] = [
      {
        shapeId: "shape:a",
        frame: {
          v: 2,
          id: "f1",
          type: "cue",
          trackId: "T",
          stepId: makeMigratedStepId(PAGE_ID, 0, 0),
          stepOrderKey: getMigratedStepOrderKey(0, 0),
          action: { type: "shapeAnimation" },
        },
      },
    ];
    const result = migrateV1Frames(
      [{ shapeId: "shape:b", frame: v1Sub("f2", "f1") }],
      persisted,
      PAGE_ID,
    );
    expect(result.updates[0].frame).toMatchObject({
      type: "sub",
      cueFrameId: "f1",
    });
    expect(result.detachedFrames).toEqual([]);
  });

  it("is idempotent: re-running over already-produced output changes nothing", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:a", frame: v1Cue("f1", 0, "T") },
      { shapeId: "shape:b", frame: v1Sub("f2", "f1") },
    ];
    const first = migrateV1Frames(input, [], PAGE_ID);
    // Everything migrated: nothing v1 remains, so a re-run has no work.
    const second = migrateV1Frames(
      [],
      first.updates.map((u) => ({ shapeId: u.shapeId, frame: u.frame })),
      PAGE_ID,
    );
    expect(second.updates).toEqual([]);
    expect(second.diagnostics).toEqual([]);
  });

  it("golden fixture: a small v1 document produces the exact expected v2 records", () => {
    const input: ShapeLegacyFrame[] = [
      { shapeId: "shape:s1", frame: v1Cue("c1", 0, "camera") },
      { shapeId: "shape:s2", frame: v1Cue("c2", 1, "obj") },
      { shapeId: "shape:s3", frame: v1Sub("u1", "c2") },
      { shapeId: "shape:s4", frame: v1Cue("c3", 1, "camera") },
    ];
    const result = migrateV1Frames(input, [], PAGE_ID);
    const byShape = Object.fromEntries(
      result.updates.map((u) => [u.shapeId, u.frame]),
    );
    expect(byShape).toEqual({
      "shape:s1": {
        v: 2,
        id: "c1",
        type: "cue",
        trackId: "camera",
        stepId: "v1step:page:xyz:0:0",
        stepOrderKey: "a0",
        action: { type: "shapeAnimation" },
      },
      "shape:s2": {
        v: 2,
        id: "c2",
        type: "cue",
        trackId: "obj",
        stepId: "v1step:page:xyz:1:0",
        stepOrderKey: "a1",
        action: { type: "shapeAnimation" },
      },
      "shape:s4": {
        v: 2,
        id: "c3",
        type: "cue",
        trackId: "camera",
        stepId: "v1step:page:xyz:1:0",
        stepOrderKey: "a1",
        action: { type: "shapeAnimation" },
      },
      "shape:s3": {
        v: 2,
        id: "u1",
        type: "sub",
        cueFrameId: "c2",
        orderKey: "a0",
        action: { type: "shapeAnimation" },
      },
    });
  });
});

describe("sub-frame chain resume (mixed-batch partial migration)", () => {
  const fullChain: ShapeLegacyFrame[] = [
    { shapeId: "shape:a", frame: v1Cue("f1", 0, "T") },
    { shapeId: "shape:b", frame: v1Sub("u1", "f1") },
    { shapeId: "shape:c", frame: v1Sub("u2", "u1") },
    { shapeId: "shape:d", frame: v1Sub("u3", "u2") },
  ];

  it("resumes an interrupted sub-frame chain byte-for-byte", () => {
    const complete = migrateV1Frames(fullChain, [], PAGE_ID);
    const completeByShape = new Map(
      complete.updates.map((u) => [u.shapeId, u.frame]),
    );

    // Interruption: the cue and the first sub persisted; u2/u3 remain v1.
    const persisted: ShapeV2Frame[] = [
      { shapeId: "shape:a", frame: completeByShape.get("shape:a")! },
      { shapeId: "shape:b", frame: completeByShape.get("shape:b")! },
    ];
    const resumed = migrateV1Frames(
      [
        { shapeId: "shape:c", frame: v1Sub("u2", "u1") },
        { shapeId: "shape:d", frame: v1Sub("u3", "u2") },
      ],
      persisted,
      PAGE_ID,
    );
    expect(resumed.detachedFrames).toEqual([]);
    const resumedByShape = new Map(
      resumed.updates.map((u) => [u.shapeId, u.frame]),
    );
    expect(resumedByShape.get("shape:c")).toEqual(
      completeByShape.get("shape:c"),
    );
    expect(resumedByShape.get("shape:d")).toEqual(
      completeByShape.get("shape:d"),
    );
  });

  it("anchors chains at already-migrated v2 sub frames instead of detaching", () => {
    const persistedSub: ShapeV2Frame = {
      shapeId: "shape:b",
      frame: {
        v: 2,
        id: "u1",
        type: "sub",
        cueFrameId: "f1",
        orderKey: getMigratedSubFrameOrderKey(0),
        action: { type: "shapeAnimation" },
      },
    };
    const result = migrateV1Frames(
      [{ shapeId: "shape:c", frame: v1Sub("u2", "u1") }],
      [persistedSub],
      PAGE_ID,
    );
    expect(result.detachedFrames).toEqual([]);
    expect(result.updates[0].frame).toMatchObject({
      type: "sub",
      cueFrameId: "f1",
      orderKey: getMigratedSubFrameOrderKey(1),
    });
  });

  it("getMigratedSubFrameOrderKey matches the complete-run key sequence", () => {
    const keys = deterministicKeysBetween(null, null, 6);
    for (let i = 0; i < keys.length; i++) {
      expect(getMigratedSubFrameOrderKey(i)).toBe(keys[i]);
    }
    expect(getMigratedSubFrameOrderKey(0)).toBe("a0");
    expect(getMigratedSubFrameOrderKey(1)).toBe("a1");
  });
});

describe("arbitrary-subset sub-chain resume (review finding 7)", () => {
  // Adversarial naming: chain order (z1 -> m2 -> a3) is the OPPOSITE of
  // id order, so any resume logic that falls back to id ordering instead
  // of reconstructed chain positions produces a different result than the
  // complete run.
  const fullDocument: ShapeLegacyFrame[] = [
    { shapeId: "shape:c", frame: v1Cue("c1", 0, "T") },
    { shapeId: "shape:z", frame: v1Sub("z1", "c1") },
    { shapeId: "shape:m", frame: v1Sub("m2", "z1") },
    { shapeId: "shape:a", frame: v1Sub("a3", "m2") },
  ];

  it("resumes every persisted subset of a complete run byte-for-byte", () => {
    const complete = migrateV1Frames(fullDocument, [], PAGE_ID);
    const completeByShape = new Map(
      complete.updates.map((u) => [u.shapeId, u.frame]),
    );
    const shapeIds = fullDocument.map((entry) => entry.shapeId);

    for (let mask = 0; mask < 1 << shapeIds.length; mask++) {
      const persistedShapeIds = new Set(
        shapeIds.filter((_, i) => (mask & (1 << i)) !== 0),
      );
      const persisted: ShapeV2Frame[] = [...persistedShapeIds].map(
        (shapeId) => ({ shapeId, frame: completeByShape.get(shapeId)! }),
      );
      const remainingV1 = fullDocument.filter(
        (entry) => !persistedShapeIds.has(entry.shapeId),
      );

      const resumed = migrateV1Frames(remainingV1, persisted, PAGE_ID);
      // Merged result (persisted ∪ resumed) must equal the complete run.
      const merged = new Map(
        persisted.map((entry) => [entry.shapeId, entry.frame]),
      );
      for (const update of resumed.updates) {
        merged.set(update.shapeId, update.frame);
      }
      for (const shapeId of shapeIds) {
        expect(merged.get(shapeId), `subset mask ${mask}`).toEqual(
          completeByShape.get(shapeId),
        );
      }
      expect(resumed.detachedFrames, `subset mask ${mask}`).toEqual([]);
    }
  });

  it("reconstructs positions when only a middle sub frame is persisted", () => {
    const complete = migrateV1Frames(fullDocument, [], PAGE_ID);
    const completeByShape = new Map(
      complete.updates.map((u) => [u.shapeId, u.frame]),
    );
    // Persist ONLY m2 (chain middle, index 1): a3 must land at index 2
    // (after its persisted predecessor) and z1 at index 0 — even though
    // a3's id sorts before z1's.
    const resumed = migrateV1Frames(
      [
        { shapeId: "shape:c", frame: v1Cue("c1", 0, "T") },
        { shapeId: "shape:z", frame: v1Sub("z1", "c1") },
        { shapeId: "shape:a", frame: v1Sub("a3", "m2") },
      ],
      [{ shapeId: "shape:m", frame: completeByShape.get("shape:m")! }],
      PAGE_ID,
    );
    const byShape = new Map(resumed.updates.map((u) => [u.shapeId, u.frame]));
    expect(byShape.get("shape:z")).toEqual(completeByShape.get("shape:z"));
    expect(byShape.get("shape:a")).toEqual(completeByShape.get("shape:a"));
  });
});
