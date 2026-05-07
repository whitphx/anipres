import type { DeleteShapeAction } from "../../schemas/agent-action.js";
import { registerActionUtil } from "../action-util.js";

/**
 * Remove a shape from the canvas. Tldraw's editor handles reparenting,
 * binding cleanup, and selection updates automatically. Frame
 * bookkeeping (cue/sub frames previously attached to the shape) is the
 * caller's responsibility — emit follow-up detach/delete actions if the
 * intent is to wipe those too.
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
