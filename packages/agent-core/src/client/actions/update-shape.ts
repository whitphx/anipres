import { toRichText } from "tldraw";
import type { UpdateShapeAction } from "../../schemas/actions.js";
import { registerActionUtil } from "../action-util.js";

/**
 * Apply a partial update to an existing tldraw shape. Each field on the
 * action is optional; only the supplied ones land on the shape. Top-level
 * geometry (x, y) goes on the shape, sized props (w, h) and styled props
 * (color, text/richText) merge into `shape.props`.
 */
export const UpdateShapeActionUtil = registerActionUtil<UpdateShapeAction>({
  type: "update",
  apply(action, { editor, helpers }) {
    const shapeId = helpers.resolveShapeId(action.shapeId);
    const shape = editor.getShape(shapeId);
    if (!shape) return;

    const propUpdates: Record<string, unknown> = {};
    if (action.w !== undefined) propUpdates.w = action.w;
    if (action.h !== undefined) propUpdates.h = action.h;
    if (action.color !== undefined) propUpdates.color = action.color;
    if (action.text !== undefined) {
      // tldraw geo/text/arrow shapes carry a TipTap richText document.
      // Replacing it is the correct way to retitle the shape.
      propUpdates.richText = toRichText(action.text);
    }

    const next: {
      id: typeof shape.id;
      type: typeof shape.type;
      x?: number;
      y?: number;
      props?: typeof shape.props;
    } = {
      id: shape.id,
      type: shape.type,
    };
    if (action.x !== undefined) next.x = action.x;
    if (action.y !== undefined) next.y = action.y;
    if (Object.keys(propUpdates).length > 0) {
      next.props = { ...shape.props, ...propUpdates };
    }

    editor.updateShape(next);
  },
});
