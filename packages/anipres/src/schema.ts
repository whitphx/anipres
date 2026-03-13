import { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
import {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";

export {
  slideShapeProps,
  SlideShapeType,
  themeImageShapeProps,
  ThemeImageShapeType,
};

export const customShapeSchemas = {
  [SlideShapeType]: { props: slideShapeProps },
  [ThemeImageShapeType]: { props: themeImageShapeProps },
};
