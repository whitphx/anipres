export { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
export {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";

import { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
import {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";

export const customShapeSchemas = {
  [SlideShapeType]: { props: slideShapeProps },
  [ThemeImageShapeType]: { props: themeImageShapeProps },
};
