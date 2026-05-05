import type { SelectedShapesPart } from "../../schemas/parts.js";
import { registerPartUtil } from "../part-util.js";

/**
 * Surface the editor's current selection so the agent can disambiguate
 * "these / the selected / highlighted" references. Headless editors
 * (CLI, MCP) just return an empty list.
 */
export const SelectedShapesPartUtil = registerPartUtil<SelectedShapesPart>({
  type: "selectedShapes",
  getPart({ editor }) {
    return {
      type: "selectedShapes",
      shapeIds: [...editor.getSelectedShapeIds()],
    };
  },
});
