import { T } from "tldraw";
import type { TLBaseShape, RecordProps } from "tldraw";

export const SlideShapeType = "slide" as const;

export type SlideShape = TLBaseShape<
  typeof SlideShapeType,
  { w: number; h: number }
>;

export const slideShapeProps: RecordProps<SlideShape> = {
  w: T.number,
  h: T.number,
};
