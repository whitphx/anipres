import type { TLShapeId } from "tldraw";
import type { Frame } from "../models";

export interface ShapeSelection {
  shapeId: TLShapeId;
  frameIds: Frame["id"][];
}
