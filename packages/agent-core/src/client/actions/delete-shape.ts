import type { DeleteShapeAction } from "../../schemas/actions.js";
import { registerActionUtil } from "../action-util.js";

/**
 * Remove a shape from the canvas. Tldraw's editor handles reparenting,
 * binding cleanup, and selection updates automatically; the
 * presentation manager's side effects renumber adjacent steps and heal
 * tracks when a frame-bearing shape is removed.
 */
export const DeleteShapeActionUtil = registerActionUtil<DeleteShapeAction>({
  type: "delete",
  apply(action, { editor, helpers }) {
    const shapeId = helpers.resolveExistingShapeId(action.shapeId);
    if (!shapeId) {
      console.warn(
        `[delete] no shape found for id "${action.shapeId}" — skipping.`,
      );
      return;
    }
    editor.deleteShape(shapeId);
  },
});
