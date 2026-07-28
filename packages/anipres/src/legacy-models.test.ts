import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonObject, TLPageId, TLShape, TLShapeId } from "tldraw";
import {
  deriveTimelineFromShapes,
  getMigratedStepOrderKey,
  migrateLegacyFrames,
  parseMigratedStepId,
} from "./legacy-models";

const action = { type: "shapeAnimation" } as const;

function shape(shapeId: string, frame: JsonObject): TLShape {
  return {
    id: shapeId as TLShapeId,
    typeName: "shape",
    type: "geo",
    parentId: "page:test" as TLPageId,
    meta: { frame },
  } as unknown as TLShape;
}

function applyUpdates(
  shapes: TLShape[],
  updates: ReturnType<typeof migrateLegacyFrames>["updates"],
) {
  const updateById = new Map(updates.map((update) => [update.id, update]));
  return shapes.map((item) => {
    const update = updateById.get(item.id);
    return update ? ({ ...item, meta: update.meta } as TLShape) : item;
  });
}

describe("deterministic v1 migration", () => {
  it("produces byte-identical valid and tolerant migration output", () => {
    const shapes = [
      shape("shape:cue", {
        id: "cue",
        type: "cue",
        globalIndex: 4,
        trackId: "track",
        action,
      }),
      shape("shape:fork-b", {
        id: "fork-b",
        type: "sub",
        prevFrameId: "cue",
        action,
      }),
      shape("shape:fork-a", {
        id: "fork-a",
        type: "sub",
        prevFrameId: "cue",
        action,
      }),
      shape("shape:detached", {
        id: "detached",
        type: "sub",
        prevFrameId: "missing",
        action,
      }),
    ];
    const first = migrateLegacyFrames(shapes, "page:test");
    const second = migrateLegacyFrames([...shapes].reverse(), "page:test");
    expect(second).toEqual(first);
    expect(first.diagnostics).toContainEqual({
      type: "forked-chain",
      prevFrameId: "cue",
      shapeIds: ["shape:fork-a", "shape:fork-b"],
    });
    expect(first.detachedFrames.map((item) => item.shapeId)).toEqual([
      "shape:detached",
    ]);
  });

  it("assigns same-track conflicts to distinct stable partitions", () => {
    const shapes = [
      shape("shape:a", {
        id: "a",
        type: "cue",
        globalIndex: 4,
        trackId: "track",
        action,
      }),
      shape("shape:b", {
        id: "b",
        type: "cue",
        globalIndex: 4,
        trackId: "track",
        action,
      }),
    ];
    const result = migrateLegacyFrames(shapes, "page:test");
    const migrated = applyUpdates(shapes, result.updates);
    const timeline = deriveTimelineFromShapes(migrated, "page:test");
    expect(timeline.steps.map((step) => step.id)).toEqual([
      "v1step:page:test:4:0",
      "v1step:page:test:4:1",
    ]);
    expect(timeline.diagnostics).not.toContainEqual(
      expect.objectContaining({ type: "same-track-split" }),
    );
  });

  it("resumes a partial same-track migration with the full-run assignment", () => {
    const original = [
      shape("shape:a", {
        id: "a",
        type: "cue",
        globalIndex: 4,
        trackId: "track",
        action,
      }),
      shape("shape:b", {
        id: "b",
        type: "cue",
        globalIndex: 4,
        trackId: "track",
        action,
      }),
    ];
    const full = migrateLegacyFrames(original, "page:test");
    const firstUpdate = full.updates.find((update) => update.id === "shape:a")!;
    const partial = applyUpdates(original, [firstUpdate]);
    const resumed = migrateLegacyFrames(partial, "page:test");
    expect(resumed.updates.find((update) => update.id === "shape:b")).toEqual(
      full.updates.find((update) => update.id === "shape:b"),
    );
    expect(deriveTimelineFromShapes(partial, "page:test")).toEqual(
      deriveTimelineFromShapes(
        applyUpdates(original, full.updates),
        "page:test",
      ),
    );
  });

  it("keeps contradictory persisted partitions and diagnoses them", () => {
    const frames = ["a", "b"].map((id) =>
      shape(`shape:${id}`, {
        v: 2,
        id,
        type: "cue",
        stepId: "v1step:page:test:1:0",
        stepOrderKey: getMigratedStepOrderKey(1, 0),
        trackId: "track",
        action,
      }),
    );
    const result = migrateLegacyFrames(frames, "page:test");
    expect(result.updates).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      type: "contradictory-migrated-partition",
      globalIndex: 1,
      partitionIndex: 0,
      trackId: "track",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  it("parses v1step coordinates from the trailing numeric segments", () => {
    expect(parseMigratedStepId("v1step:page:with:colons:-2:3")).toEqual({
      pageId: "page:with:colons",
      globalIndex: -2,
      partitionIndex: 3,
    });
    expect(
      parseMigratedStepId("v1step:page:test:not-a-number:0"),
    ).toBeUndefined();
  });

  it("diagnoses legacy-shaped metadata that tolerant parsing cannot read", () => {
    const malformed = shape("shape:broken", {
      id: "broken",
      type: "cue",
      globalIndex: "not-a-number",
      trackId: "track",
      action,
    });
    expect(
      deriveTimelineFromShapes([malformed], "page:test").diagnostics,
    ).toContainEqual({
      type: "invalid-frame",
      shapeId: "shape:broken",
    });
  });

  it("matches the v1 to v2 golden fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./__fixtures__/animation-v1-golden.json", import.meta.url),
        "utf8",
      ),
    ) as {
      pageId: string;
      shapes: { shapeId: string; frame: JsonObject }[];
    };
    const shapes = fixture.shapes.map((item) =>
      shape(item.shapeId, item.frame),
    );
    const result = migrateLegacyFrames(shapes, fixture.pageId);
    const migrated = applyUpdates(shapes, result.updates);
    const timeline = deriveTimelineFromShapes(migrated, fixture.pageId);
    expect(timeline.steps).toHaveLength(1);
    expect(timeline.steps[0].id).toBe("v1step:page:golden:2:0");
    expect(timeline.steps[0].batches).toHaveLength(2);
    expect(timeline.steps[0].batches[0].frames).toHaveLength(2);
  });
});
