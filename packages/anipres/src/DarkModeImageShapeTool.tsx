import { BaseBoxShapeTool } from "tldraw";
import { ThemeImageShapeType } from "./DarkModeImageShapeUtil";

export class ThemeImageShapeTool extends BaseBoxShapeTool {
  static override readonly id = "themeImage";
  static override initial = "idle";
  override shapeType = ThemeImageShapeType;
}
