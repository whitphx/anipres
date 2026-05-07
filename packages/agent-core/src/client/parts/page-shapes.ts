import type { PageShapesPart } from "../../schemas/prompt-part.js";
import { tldrawShapeToFocusedShape } from "../../format/convert-tldraw-shape-to-focused-shape.js";
import { registerPartUtil } from "../part-util.js";

export const PageShapesPartUtil = registerPartUtil<PageShapesPart>({
  type: "pageShapes",
  getPart({ editor }) {
    const shapes = editor
      .getCurrentPageShapes()
      .map((shape) => tldrawShapeToFocusedShape(editor, shape.id))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    return { type: "pageShapes", shapes };
  },
});
