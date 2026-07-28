import { describe, expect, it } from "vitest";
import type { TLShapeId } from "tldraw";
import {
  compareOrderKeys,
  deriveTimeline,
  type CueFrame,
  type FrameRecord,
  type SubFrame,
} from "../models";
import { moveFrame } from "./frame-movement";
import { calcFrameBatchUIData } from "./frame-ui-data";

const action = { type: "shapeAnimation" } as const;

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
    action,
  };
}

function sub(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return {
    v: 2,
    id,
    type: "sub",
    cueFrameId,
    orderKey,
    action,
  };
}

function record(shapeId: string, frame: CueFrame | SubFrame): FrameRecord {
  return { shapeId: shapeId as TLShapeId, frame };
}

function move(
  records: FrameRecord[],
  trackId: string,
  srcStepIndex: number,
  srcTrackIndex: number,
  dstStepIndex: number,
  dstType: "after" | "at",
) {
  const timeline = deriveTimeline(records);
  const { steps } = calcFrameBatchUIData(timeline, records);
  const mutations = moveFrame(
    steps,
    trackId,
    srcStepIndex,
    srcTrackIndex,
    dstStepIndex,
    dstType,
  );
  if (!mutations) return undefined;
  const mutationByShapeId = new Map(
    mutations.map((mutation) => [mutation.shapeId, mutation.frame]),
  );
  const updated = records.map((item) => ({
    ...item,
    frame: mutationByShapeId.get(item.shapeId) ?? item.frame,
  }));
  return calcFrameBatchUIData(deriveTimeline(updated), updated).steps.map(
    (step) =>
      step.map(
        (batch) =>
          batch.trackId + ":" + batch.data.map((frame) => frame.id).join(","),
      ),
  );
}

const base = [
  record("shape:1", cue("t1", "s1", "a1", "T")),
  record("shape:2", cue("u1", "s2", "a2", "U")),
  record("shape:3", cue("t2", "s3", "a3", "T")),
  record("shape:4", sub("t3", "t2", "a0")),
];

describe("moveFrame", () => {
  it("moves a whole batch right", () => {
    expect(move(base, "T", 0, 0, 1, "after")).toEqual([
      ["U:u1"],
      ["T:t1"],
      ["T:t2,t3"],
    ]);
  });

  it("merges right into an existing same-track batch", () => {
    expect(move(base, "T", 0, 0, 2, "at")).toEqual([["U:u1"], ["T:t1,t2,t3"]]);
  });

  it("splits a batch when moving its sub-frame right", () => {
    expect(move(base, "T", 2, 2, 2, "after")).toEqual([
      ["T:t1"],
      ["U:u1"],
      ["T:t2"],
      ["T:t3"],
    ]);
  });

  it("moves a whole batch left while sweeping earlier same-track batches", () => {
    expect(move(base, "T", 2, 2, -1, "after")).toEqual([
      ["T:t1"],
      ["T:t2,t3"],
      ["U:u1"],
    ]);
  });

  it("merges left into an existing same-track batch", () => {
    expect(move(base, "T", 2, 2, 0, "at")).toEqual([["T:t1,t2,t3"], ["U:u1"]]);
  });

  it("sweeps intermediate same-track batches", () => {
    const records = [
      record("shape:1", cue("t1", "s1", "a1", "T")),
      record("shape:2", cue("t2", "s2", "a2", "T")),
      record("shape:3", cue("u1", "s3", "a3", "U")),
    ];
    expect(move(records, "T", 0, 0, 2, "after")).toEqual([
      ["U:u1"],
      ["T:t1"],
      ["T:t2"],
    ]);
  });

  it("promotes the remaining sub-frame when its cue moves left", () => {
    expect(move(base, "T", 2, 1, -1, "after")).toEqual([
      ["T:t1"],
      ["T:t2"],
      ["U:u1"],
      ["T:t3"],
    ]);
  });

  it("moves a step before the first key and re-derives it in that position", () => {
    const records = [
      record("shape:first", cue("first", "step-first", "a0", "A")),
      record("shape:moved", cue("moved", "step-moved", "a1", "B")),
    ];
    const timeline = deriveTimeline(records);
    const { steps } = calcFrameBatchUIData(timeline, records);
    const mutations = moveFrame(steps, "B", 1, 0, -1, "after")!;
    const mutationByShapeId = new Map(
      mutations.map((mutation) => [mutation.shapeId, mutation.frame]),
    );
    const updated = records.map((item) => ({
      ...item,
      frame: mutationByShapeId.get(item.shapeId) ?? item.frame,
    }));
    const moved = updated.find((item) => item.shapeId === "shape:moved")?.frame;
    expect(moved?.type).toBe("cue");
    if (moved?.type === "cue") {
      expect(compareOrderKeys(moved.stepOrderKey, "a0")).toBeLessThan(0);
    }
    expect(deriveTimeline(updated).steps.map((step) => step.id)).toEqual([
      "step-moved",
      "step-first",
    ]);
  });
});
