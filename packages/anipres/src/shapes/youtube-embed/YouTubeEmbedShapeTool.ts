import { BaseBoxShapeTool } from "tldraw";
import { YouTubeEmbedShapeType } from "./YouTubeEmbedShape";

export class YouTubeEmbedShapeTool extends BaseBoxShapeTool {
  static override readonly id = YouTubeEmbedShapeType;
  static override initial = "idle";
  override shapeType = YouTubeEmbedShapeType;
}
