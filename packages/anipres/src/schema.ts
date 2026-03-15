import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
} from "@tldraw/tlschema";
import { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape";
import {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape";

export const anipresSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [SlideShapeType]: {
      props: slideShapeProps,
    },
    [ThemeImageShapeType]: {
      props: themeImageShapeProps,
    },
  },
  bindings: defaultBindingSchemas,
});
