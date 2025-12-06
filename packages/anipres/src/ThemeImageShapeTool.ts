import { BaseBoxShapeTool } from "tldraw";

import { themeImageShapeType } from "./ThemeImageShape";

export class ThemeImageShapeTool extends BaseBoxShapeTool {
  static override readonly id = themeImageShapeType;
  static override initial = "idle";
  override shapeType = themeImageShapeType;
}
