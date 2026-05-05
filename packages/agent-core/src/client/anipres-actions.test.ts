// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { loadHeadlessEditor } from "anipres";
import { getCueFrame } from "anipres/models";
import "./actions/create-shape.js";
import "./actions/attach-cue-frame.js";
import "./actions/update-shape.js";
import { applyActionStream } from "./apply-action-stream.js";
import type {
  AttachCueFrameAction,
  CreateAction,
  UpdateShapeAction,
} from "../schemas/actions.js";
import type { Streaming } from "../types.js";

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function complete<T>(action: T): Streaming<T> {
  return { ...action, complete: true } as Streaming<T>;
}

describe("anipres action utils", () => {
  it("auto-attaches a cameraZoom cue when creating a slide", async () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const create: CreateAction = {
        _type: "create",
        intent: "first slide",
        shape: {
          _type: "slide",
          shapeId: "s1",
          x: 0,
          y: 0,
          w: 1280,
          h: 720,
        },
      };

      await applyActionStream({
        editor,
        actions: fromArray([complete(create)]),
      });

      const slide = editor
        .getCurrentPageShapes()
        .find((s) => s.type === "slide");
      expect(slide).toBeTruthy();
      const cue = getCueFrame(slide!);
      expect(cue).toBeTruthy();
      expect(cue?.action.type).toBe("cameraZoom");
      expect(cue?.globalIndex).toBe(0);
    } finally {
      dispose();
    }
  });

  it("creates a new step with attachCueFrame and continues a track via prevShapeId", async () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const createStart: CreateAction = {
        _type: "create",
        intent: "start rect",
        shape: {
          _type: "rectangle",
          shapeId: "start",
          x: 0,
          y: 0,
          w: 100,
          h: 60,
          color: "blue",
          text: "",
        },
      };
      const cueStart: AttachCueFrameAction = {
        _type: "attachCueFrame",
        intent: "open animation track",
        shapeId: "start",
        action: { type: "shapeAnimation" },
      };
      const createEnd: CreateAction = {
        _type: "create",
        intent: "end rect",
        shape: {
          _type: "rectangle",
          shapeId: "end",
          x: 200,
          y: 0,
          w: 100,
          h: 60,
          color: "blue",
          text: "",
        },
      };
      const cueEnd: AttachCueFrameAction = {
        _type: "attachCueFrame",
        intent: "extend animation track to next step",
        shapeId: "end",
        prevShapeId: "start",
        action: { type: "shapeAnimation", duration: 1000 },
      };

      await applyActionStream({
        editor,
        actions: fromArray([
          complete(createStart),
          complete(cueStart),
          complete(createEnd),
          complete(cueEnd),
        ]),
      });

      const shapes = editor.getCurrentPageShapes();
      const rectShapes = shapes.filter((s) => s.type === "geo");
      expect(rectShapes).toHaveLength(2);

      const cues = rectShapes
        .map((s) => getCueFrame(s))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      expect(cues).toHaveLength(2);
      // Both cues share a track
      expect(new Set(cues.map((c) => c.trackId)).size).toBe(1);
      // GlobalIndexes are different — one per step
      const indexes = cues.map((c) => c.globalIndex).sort();
      expect(indexes).toEqual([0, 1]);
    } finally {
      dispose();
    }
  });

  it("update can target a shape that came in with the snapshot (not just one created in the same turn)", async () => {
    // Repro for the bug where `update` couldn't reach existing snapshot
    // shapes because `resolveShapeId` treated their ids as collisions
    // and minted a fresh random id, leaving `editor.getShape(id)` empty.
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // Pre-populate via the editor directly — simulates a shape that
      // arrived via the loaded snapshot rather than via a `create`
      // action this turn.
      editor.createShape({
        id: "shape:preexisting" as never,
        type: "geo",
        x: 10,
        y: 10,
        props: {
          w: 50,
          h: 50,
          geo: "rectangle",
          color: "blue",
        },
      });

      const update: UpdateShapeAction = {
        _type: "update",
        intent: "recolor preexisting",
        shapeId: "shape:preexisting",
        color: "orange",
      };

      await applyActionStream({
        editor,
        actions: fromArray([complete(update)]),
      });

      const shape = editor.getShape("shape:preexisting" as never);
      expect(shape).toBeTruthy();
      const props = shape!.props as { color: string };
      expect(props.color).toBe("orange");
    } finally {
      dispose();
    }
  });

  it("update changes color and position of an existing shape", async () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const create: CreateAction = {
        _type: "create",
        intent: "rect to recolor",
        shape: {
          _type: "rectangle",
          shapeId: "r",
          x: 0,
          y: 0,
          w: 100,
          h: 60,
          color: "blue",
          text: "",
        },
      };
      const update: UpdateShapeAction = {
        _type: "update",
        intent: "make it orange and move it",
        shapeId: "r",
        color: "orange",
        x: 50,
        y: 80,
      };

      await applyActionStream({
        editor,
        actions: fromArray([complete(create), complete(update)]),
      });

      const shape = editor
        .getCurrentPageShapes()
        .find((s) => s.type === "geo")!;
      expect(shape.x).toBe(50);
      expect(shape.y).toBe(80);
      const props = shape.props as { color: string };
      expect(props.color).toBe("orange");
    } finally {
      dispose();
    }
  });
});
