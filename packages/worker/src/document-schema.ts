import {
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
} from "tldraw";
import {
  mediaControlBindingProps,
  MediaControlBindingType,
  mediaControlShapeProps,
  MediaControlShapeType,
  slideShapeProps,
  SlideShapeType,
  themeImageShapeProps,
  ThemeImageShapeType,
  youTubeEmbedShapeProps,
  YouTubeEmbedShapeType,
} from "anipres/schema";

export const documentSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [SlideShapeType]: { props: slideShapeProps },
    [ThemeImageShapeType]: { props: themeImageShapeProps },
    [YouTubeEmbedShapeType]: { props: youTubeEmbedShapeProps },
    [MediaControlShapeType]: { props: mediaControlShapeProps },
  },
  bindings: {
    ...defaultBindingSchemas,
    [MediaControlBindingType]: { props: mediaControlBindingProps },
  },
});
