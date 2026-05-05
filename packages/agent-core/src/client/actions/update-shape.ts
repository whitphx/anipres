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
    const shapeId = helpers.resolveExistingShapeId(action.shapeId);
    if (!shapeId) {
      console.warn(
        `[update] no existing shape found for id "${action.shapeId}" — skipping.`,
      );
      return;
    }
    const shape = editor.getShape(shapeId);
    if (!shape) return;

    const propUpdates: Record<string, unknown> = {};
    if (action.w !== undefined) propUpdates.w = action.w;
    if (action.h !== undefined) propUpdates.h = action.h;
    if (action.color !== undefined) propUpdates.color = action.color;
    if (action.text !== undefined) {
      // Geo, text, and note shapes carry a TipTap richText doc; the
      // tldraw v3 arrow shape carries a plain `text: string` instead
      // (verified against @tldraw/tlschema@3.15.5 TLArrowShape props).
      // Sending `richText` to an arrow gets dropped silently and the
      // user thinks the recolor "worked" but nothing changed.
      if (shape.type === "arrow") {
        propUpdates.text = action.text;
      } else {
        propUpdates.richText = toRichText(action.text);
      }
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
