import { describe, expect, it } from "vitest";
import type { TLShapeId } from "tldraw";
import {
  compareOrderKeys,
  SYNTHETIC_STEP_PREFIX,
  deriveTimeline,
  getOrderKeyBetween,
  makeInsertionSpace,
  parseFrameObject,
  type CueFrame,
  type FrameRecord,
  type SubFrame,
} from "./models";

const action = { type: "shapeAnimation" } as const;

function cue(
  shapeId: string,
  id: string,
  stepId: string,
  stepOrderKey: string,
  trackId: string,
): FrameRecord {
  return {
    shapeId: shapeId as TLShapeId,
    frame: {
      v: 2,
      id,
      type: "cue",
      stepId,
      stepOrderKey,
      trackId,
      action,
    },
  };
}

function sub(
  shapeId: string,
  id: string,
  cueFrameId: string,
  orderKey: string,
): FrameRecord {
  return {
    shapeId: shapeId as TLShapeId,
    frame: { v: 2, id, type: "sub", cueFrameId, orderKey, action },
  };
}

describe("v2 frame parsing", () => {
  it("accepts v2 frames and rejects malformed and reserved persisted steps", () => {
    const valid: CueFrame = {
      v: 2,
      id: "frame",
      type: "cue",
      trackId: "track",
      stepId: "step",
      stepOrderKey: "a1",
      action,
    };
    expect(parseFrameObject(valid)).toEqual(valid);
    expect(parseFrameObject({ ...valid, v: 3 })).toBeUndefined();
    expect(
      parseFrameObject({
        ...valid,
        stepId: `${SYNTHETIC_STEP_PREFIX}["stored","shape:x"]`,
      }),
    ).toBeUndefined();
  });
});

describe("deriveTimeline", () => {
  it("orders a generated before-first step before the existing first step", () => {
    const before = getOrderKeyBetween(undefined, "a0");
    expect(compareOrderKeys(before, "a0")).toBeLessThan(0);

    const timeline = deriveTimeline([
      cue("shape:current", "current", "current", "a0", "current-track"),
      cue("shape:before", "before", "before", before, "before-track"),
    ]);
    expect(timeline.steps.map((step) => step.id)).toEqual([
      "before",
      "current",
    ]);
  });

  it("ports v1 ordering behavior while grouping only by explicit step identity", () => {
    const timeline = deriveTimeline([
      cue("shape:k2", "k2", "step-3", "a3", "A"),
      cue("shape:k3", "k3", "step-2", "a2", "B"),
      cue("shape:k1", "k1", "step-1", "a1", "A"),
      cue("shape:k4", "k4", "step-2", "a2", "C"),
    ]);
    expect(timeline.steps.map((step) => step.id)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
    expect(timeline.steps[1].batches).toHaveLength(2);
  });

  it("keeps equal-key steps distinct and deterministically ordered by stepId", () => {
    const timeline = deriveTimeline([
      cue("shape:b", "b", "step-b", "a1", "B"),
      cue("shape:a", "a", "step-a", "a1", "A"),
    ]);
    expect(timeline.steps.map((step) => step.id)).toEqual(["step-a", "step-b"]);
  });

  it("uses the stable frame-id representative for divergent keys", () => {
    const records = [
      cue("shape:b", "b", "step", "a9", "B"),
      cue("shape:a", "a", "step", "a1", "A"),
      cue("shape:middle", "m", "middle", "a5", "M"),
    ];
    const timeline = deriveTimeline(records);
    expect(timeline.steps.map((step) => step.id)).toEqual(["step", "middle"]);
    expect(timeline.diagnostics).toContainEqual({
      type: "step-key-divergence",
      stepId: "step",
      shapeIds: ["shape:b"],
    });

    const withoutRepresentative = deriveTimeline(
      records.slice(0, 1).concat(records[2]),
    );
    expect(withoutRepresentative.steps.map((step) => step.id)).toEqual([
      "middle",
      "step",
    ]);
  });

  it("splits same-track batches into stable, injective synthetic steps", () => {
    const records = [
      cue("shape:a:b", "a", "source:b", "a1", "track"),
      cue("shape:c", "b", "source:b", "a1", "track"),
    ];
    const first = deriveTimeline(records);
    const reversed = deriveTimeline([...records].reverse());
    expect(reversed.steps).toEqual(first.steps);
    expect(first.steps[1].synthetic).toEqual({
      reason: "same-track-split",
      sourceStepId: "source:b",
    });

    const other = deriveTimeline([
      cue("shape:b:c", "a", "source", "a1", "track"),
      cue("shape:d", "b", "source", "a1", "track"),
    ]);
    expect(first.steps[1].id).not.toBe(other.steps[1].id);
    expect(first.steps[1].id.startsWith(SYNTHETIC_STEP_PREFIX)).toBe(true);
  });

  it("keeps duplicate frame ids losslessly and attaches subs to the cue representative", () => {
    const timeline = deriveTimeline([
      cue("shape:b", "duplicate", "step", "a1", "B"),
      cue("shape:a", "duplicate", "step", "a1", "A"),
      sub("shape:sub", "sub", "duplicate", "a1"),
    ]);
    expect(
      timeline.steps
        .flatMap((step) => step.batches)
        .flatMap((batch) => batch.frames),
    ).toHaveLength(3);
    const batchWithSub = timeline.steps[0].batches.find((batch) =>
      batch.frames.some((frame) => frame.shapeId === "shape:sub"),
    );
    expect(batchWithSub?.frames[0].shapeId).toBe("shape:a");
    expect(timeline.diagnostics).toContainEqual({
      type: "duplicate-frame-id",
      frameId: "duplicate",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  it("surfaces dangling sub-frames instead of dropping them", () => {
    const timeline = deriveTimeline([sub("shape:sub", "sub", "missing", "a1")]);
    expect(timeline.detachedFrames).toEqual([
      { frameId: "sub", shapeId: "shape:sub", action },
    ]);
    expect(timeline.diagnostics).toContainEqual({
      type: "detached-sub-frame",
      shapeId: "shape:sub",
      cueFrameId: "missing",
    });
  });
});

describe("makeInsertionSpace", () => {
  it("uses a local key when neighbors differ", () => {
    const result = makeInsertionSpace(
      [
        { id: "a", key: "a1" },
        { id: "b", key: "a2" },
      ],
      1,
    );
    expect(result.updates).toEqual([]);
    expect(compareOrderKeys("a1", result.insertedKey)).toBeLessThan(0);
    expect(compareOrderKeys(result.insertedKey, "a2")).toBeLessThan(0);
  });

  it("normalizes equal-key runs in current order for steps and sub-frames", () => {
    const result = makeInsertionSpace(
      [
        { id: "before", key: "a1" },
        { id: "first", key: "a2" },
        { id: "second", key: "a2" },
        { id: "after", key: "a3" },
      ],
      2,
    );
    const keys = [
      result.updates.find((update) => update.id === "first")!.key,
      result.insertedKey,
      result.updates.find((update) => update.id === "second")!.key,
    ];
    expect(keys).toEqual([...keys].sort(compareOrderKeys));
    expect(
      keys.every(
        (key) =>
          compareOrderKeys("a1", key) < 0 && compareOrderKeys(key, "a3") < 0,
      ),
    ).toBe(true);
  });

  it("remains total after concurrent normalizations re-collide under record LWW", () => {
    const items = [
      { id: "a", key: "a1" },
      { id: "b", key: "a1" },
    ];
    const left = makeInsertionSpace(items, 1);
    const right = makeInsertionSpace(items, 1);
    const merged = [
      { id: "a", key: left.updates[0].key },
      { id: "b", key: right.updates[1].key },
    ].sort(
      (a, b) => compareOrderKeys(a.key, b.key) || a.id.localeCompare(b.id),
    );
    expect(() => makeInsertionSpace(merged, 1)).not.toThrow();
  });
});

it("orders sub-frames by key and id without shadowing forks", () => {
  const cueRecord = cue("shape:cue", "cue", "step", "a1", "track");
  const subs: SubFrame[] = [
    { v: 2, id: "b", type: "sub", cueFrameId: "cue", orderKey: "a1", action },
    { v: 2, id: "a", type: "sub", cueFrameId: "cue", orderKey: "a1", action },
  ];
  const timeline = deriveTimeline([
    cueRecord,
    { shapeId: "shape:b" as TLShapeId, frame: subs[0] },
    { shapeId: "shape:a" as TLShapeId, frame: subs[1] },
  ]);
  expect(
    timeline.steps[0].batches[0].frames.map((frame) => frame.frameId),
  ).toEqual(["cue", "a", "b"]);
});

it("orders a generated before-first sub-frame before the current first sub-frame", () => {
  const before = getOrderKeyBetween(undefined, "a0");
  const timeline = deriveTimeline([
    cue("shape:cue", "cue", "step", "a0", "track"),
    sub("shape:current", "current", "cue", "a0"),
    sub("shape:before", "before", "cue", before),
  ]);
  expect(
    timeline.steps[0].batches[0].frames.map((frame) => frame.frameId),
  ).toEqual(["cue", "before", "current"]);
});
