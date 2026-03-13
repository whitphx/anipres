import {
  createTLSchema,
  defaultShapeSchemas,
} from "tldraw";
import {
  SlideShapeType,
  slideShapeProps,
  ThemeImageShapeType,
  themeImageShapeProps,
} from "anipres/schema";

export const anipresSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [SlideShapeType]: { props: slideShapeProps },
    [ThemeImageShapeType]: { props: themeImageShapeProps },
  },
});
