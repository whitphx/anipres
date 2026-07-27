import { describe, it, expect } from "vitest";
import { calculateTotalSteps } from "./headless-editor-utils";
import type { TLStoreSnapshot } from "tldraw";

function makeShapeRecord(
  id: string,
  frame: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    props: {},
    meta: frame ? { frame } : {},
  };
}

function makeSnapshot(shapes: Record<string, unknown>[]): TLStoreSnapshot {
  const store: Record<string, unknown> = {
    "document:document": { typeName: "document", id: "document:document" },
    "page:page": {
      typeName: "page",
      id: "page:page",
      name: "Page",
      index: "a1",
    },
  };
  for (const shape of shapes) {
    store[shape.id as string] = shape;
  }
  return { store, schema: {} } as unknown as TLStoreSnapshot;
}

function cueFrame(id: string, globalIndex: number, trackId: string) {
  return {
    id,
    type: "cue",
    globalIndex,
    trackId,
    action: { type: "shapeAnimation" },
  };
}

describe("calculateTotalSteps (snapshot JSON, no headless editor)", () => {
  it("returns 0 for a snapshot with no frames", () => {
    const snapshot = makeSnapshot([makeShapeRecord("s1", null)]);
    expect(calculateTotalSteps(snapshot)).toBe(0);
  });

  it("counts distinct globalIndex groups as steps", () => {
    const snapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
      makeShapeRecord("s2", cueFrame("f2", 1, "A")),
      makeShapeRecord("s3", cueFrame("f3", 1, "B")), // simultaneous with f2
    ]);
    expect(calculateTotalSteps(snapshot)).toBe(2);
  });

  it("accepts a TLEditorSnapshot-shaped input ({ document })", () => {
    const storeSnapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
    ]);
    expect(calculateTotalSteps({ document: storeSnapshot })).toBe(1);
  });

  it("chains sub-frames into their cue's batch without affecting the count", () => {
    const snapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
      makeShapeRecord("s2", {
        id: "f2",
        type: "sub",
        prevFrameId: "f1",
        action: { type: "shapeAnimation" },
      }),
    ]);
    expect(calculateTotalSteps(snapshot)).toBe(1);
  });
});
