import { describe, expect, it } from "vitest";
import type { JsonObject, TLContent, TLShape, TLShapeId } from "tldraw";
import { parseFrameObject } from "./models";
import { preprocessAnimationContent } from "./preprocess-animation-content";

const action = { type: "shapeAnimation" } as const;

function shape(id: string, frame: JsonObject): TLShape {
  return {
    id: id as TLShapeId,
    typeName: "shape",
    type: "geo",
    parentId: "page:test",
    meta: { frame },
  } as unknown as TLShape;
}

function cue(
  shapeId: string,
  frameId: string,
  stepId: string,
  key: string,
  trackId: string,
) {
  return shape(shapeId, {
    v: 2,
    id: frameId,
    type: "cue",
    stepId,
    stepOrderKey: key,
    trackId,
    action,
  });
}

function sub(shapeId: string, frameId: string, cueFrameId: string) {
  return shape(shapeId, {
    v: 2,
    id: frameId,
    type: "sub",
    cueFrameId,
    orderKey: "a1",
    action,
  });
}

function content(shapes: TLShape[]): TLContent {
  return {
    shapes,
    assets: [],
    bindings: [],
    rootShapeIds: shapes.map((item) => item.id),
    schema: {} as TLContent["schema"],
  };
}

function options() {
  let frame = 0;
  let step = 0;
  let track = 0;
  return {
    createFrameId: () => `new-frame-${frame++}`,
    createStepId: () => `new-step-${step++}`,
    createTrackId: () => `new-track-${track++}`,
  };
}

function framesByShapeId(value: TLContent) {
  return Object.fromEntries(
    [...value.shapes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => [item.id, parseFrameObject(item.meta.frame)]),
  );
}

describe("preprocessAnimationContent", () => {
  it("preserves grouping and tracks through all operation-scoped maps", () => {
    const existing = [
      cue("shape:a", "frame-a", "step-1", "a1", "track"),
      sub("shape:sub", "frame-sub", "frame-a"),
      cue("shape:b", "frame-b", "step-2", "a2", "track"),
    ];
    const copied = content(existing.map((item) => structuredClone(item)));
    preprocessAnimationContent(copied, existing, options());
    const frames = framesByShapeId(copied);
    expect(frames["shape:a"]?.id).not.toBe("frame-a");
    expect(frames["shape:b"]?.id).not.toBe("frame-b");
    expect(frames["shape:a"]?.type).toBe("cue");
    expect(frames["shape:b"]?.type).toBe("cue");
    if (
      frames["shape:a"]?.type !== "cue" ||
      frames["shape:b"]?.type !== "cue"
    ) {
      throw new Error("Expected cue frames");
    }
    expect(frames["shape:a"].stepId).not.toBe("step-1");
    expect(frames["shape:b"].stepId).not.toBe("step-2");
    expect(frames["shape:a"].trackId).toBe(frames["shape:b"].trackId);
    expect(frames["shape:a"].trackId).not.toBe("track");
    expect(frames["shape:sub"]?.type).toBe("sub");
    if (frames["shape:sub"]?.type === "sub") {
      expect(frames["shape:sub"].cueFrameId).toBe(frames["shape:a"].id);
    }
  });

  it("is independent of TLContent shape iteration order", () => {
    const existing = [
      cue("shape:a", "a", "step", "a1", "track"),
      cue("shape:b", "b", "step", "a1", "other"),
      sub("shape:sub", "sub", "a"),
    ];
    const forward = content(existing.map((item) => structuredClone(item)));
    const reversed = content(
      [...existing].reverse().map((item) => structuredClone(item)),
    );
    preprocessAnimationContent(forward, existing, options());
    preprocessAnimationContent(reversed, existing, options());
    expect(framesByShapeId(reversed)).toEqual(framesByShapeId(forward));
  });

  it("freshens duplicate source frame ids losslessly and resolves ambiguous refs", () => {
    const copied = content([
      cue("shape:b", "duplicate", "foreign", "a1", "B"),
      cue("shape:a", "duplicate", "foreign", "a1", "A"),
      sub("shape:sub", "sub", "duplicate"),
    ]);
    const diagnostics = preprocessAnimationContent(copied, [], options());
    const frames = framesByShapeId(copied);
    expect(frames["shape:a"]?.id).not.toBe(frames["shape:b"]?.id);
    if (frames["shape:sub"]?.type === "sub") {
      expect(frames["shape:sub"].cueFrameId).toBe(frames["shape:a"]?.id);
    }
    expect(diagnostics).toEqual([
      {
        type: "ambiguous-cue-reference",
        cueFrameId: "duplicate",
        sourceShapeIds: ["shape:a", "shape:b"],
        subShapeId: "shape:sub",
      },
    ]);
  });

  it("keeps unknown foreign identities and remaps local collisions", () => {
    const existing = [cue("shape:local", "local", "shared", "a1", "track")];
    const foreign = content([
      cue("shape:foreign", "foreign", "unknown", "a9", "foreign-track"),
    ]);
    preprocessAnimationContent(foreign, existing, options());
    const kept = parseFrameObject(foreign.shapes[0].meta.frame);
    expect(kept?.type === "cue" && kept.stepId).toBe("unknown");
    expect(kept?.type === "cue" && kept.trackId).toBe("foreign-track");

    const colliding = content([
      cue("shape:foreign", "foreign", "shared", "a9", "track"),
    ]);
    preprocessAnimationContent(colliding, existing, options());
    const remapped = parseFrameObject(colliding.shapes[0].meta.frame);
    expect(remapped?.type === "cue" && remapped.stepId).not.toBe("shared");
    expect(remapped?.type === "cue" && remapped.trackId).not.toBe("track");
  });

  it("freshens the reserved synthetic step namespace on paste", () => {
    const copied = content([
      cue(
        "shape:foreign",
        "foreign",
        'synthstep:["source","shape:x"]',
        "a1",
        "track",
      ),
    ]);
    preprocessAnimationContent(copied, [], options());
    const frame = parseFrameObject(copied.shapes[0].meta.frame);
    expect(frame?.type === "cue" && frame.stepId).toBe("new-step-0");
  });
});
