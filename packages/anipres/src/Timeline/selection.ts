import type { TLShapeId } from "tldraw";

export interface ShapeSelection {
  shapeId: TLShapeId;
  /** Shape ids of the selection's leaf shapes that carry frames. */
  frameShapeIds: string[];
}
