import { BaseBoxShapeTool } from "tldraw";

import { ThemeImageShapeType } from "./ThemeImageShape";

export class ThemeImageShapeTool extends BaseBoxShapeTool {
  static override readonly id = ThemeImageShapeType;
  static override initial = "idle";
  override shapeType = ThemeImageShapeType;
}
