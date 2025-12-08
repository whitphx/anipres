import { BaseBoxShapeTool } from "tldraw";

export class SlideShapeTool extends BaseBoxShapeTool {
  static override readonly id = "slide";
  static override initial = "idle";
  override shapeType = "slide";
}
