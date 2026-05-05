import type { CreateAction } from "../../schemas/actions.js";
import { registerActionUtil } from "../action-util.js";
import { focusedShapeToTldrawShape } from "../convert-shape.js";

export const CreateShapeActionUtil = registerActionUtil<CreateAction>({
  type: "create",
  apply(action, { editor, helpers }) {
    const partial = focusedShapeToTldrawShape(action.shape, helpers);
    editor.createShape(partial);
  },
});
