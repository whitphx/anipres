import type { PageShapesPart } from "../../schemas/parts.js";
import { tldrawShapeToFocusedShape } from "../convert-shape.js";
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
