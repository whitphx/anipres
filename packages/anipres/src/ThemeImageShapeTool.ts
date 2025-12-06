import { BaseBoxShapeTool } from "tldraw";

import { ThemeImageShapeType } from "./ThemeImageShapeUtil";

export class ThemeImageShapeTool extends BaseBoxShapeTool {
  static override readonly id = ThemeImageShapeType;
  static override initial = "idle";
  override shapeType = ThemeImageShapeType;
}
