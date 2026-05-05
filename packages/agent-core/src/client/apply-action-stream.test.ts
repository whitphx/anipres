// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { loadHeadlessEditor } from "anipres";
import { applyActionStream } from "./apply-action-stream.js";
import "./actions/create-shape.js";
import type { CreateAction } from "../schemas/actions.js";
import type { Streaming } from "../types.js";

async function* once<T>(value: T): AsyncIterable<T> {
  yield value;
}

describe("applyActionStream", () => {
  it("creates a rectangle shape for a CreateAction", async () => {
    const [editor, dispose] = loadHeadlessEditor();

    try {
      const before = editor.getCurrentPageShapes().length;

      const action: Streaming<CreateAction> = {
        _type: "create",
        intent: "draw a black rectangle",
        complete: true,
        shape: {
          _type: "rectangle",
          shapeId: "r1",
          x: 10,
          y: 20,
          w: 100,
          h: 60,
          color: "black",
          text: "hello",
        },
      };

      await applyActionStream({ editor, actions: once(action) });

      const after = editor.getCurrentPageShapes();
      expect(after.length).toBe(before + 1);

      const shape = after[after.length - 1];
      expect(shape.type).toBe("geo");
      expect(shape.x).toBe(10);
      expect(shape.y).toBe(20);
      const props = shape.props as { w: number; h: number; geo: string };
      expect(props.w).toBe(100);
      expect(props.h).toBe(60);
      expect(props.geo).toBe("rectangle");
    } finally {
      dispose();
    }
  });

  it("skips incomplete actions", async () => {
    const [editor, dispose] = loadHeadlessEditor();

    try {
      const before = editor.getCurrentPageShapes().length;

      const action: Streaming<CreateAction> = {
        _type: "create",
        intent: "incomplete",
        complete: false,
        shape: {
          _type: "rectangle",
          shapeId: "r2",
          x: 0,
          y: 0,
          w: 50,
          h: 50,
          color: "red",
          text: "",
        },
      };

      await applyActionStream({ editor, actions: once(action) });

      expect(editor.getCurrentPageShapes().length).toBe(before);
    } finally {
      dispose();
    }
  });
});
