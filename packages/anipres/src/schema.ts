// This file is a separate ESM entry point ("anipres/schema") that only
// exposes pure-TS shape props and types used by both the client and
// server — no React, no ShapeUtils. This allows non-React consumers
// like the Cloudflare Worker to import them without pulling in the
// React component tree from the main entry.
//
// Application-deployment policy values (asset size limits, etc.) live
// in the `anipres-shared` workspace package, not here. The `anipres`
// library is a generic tldraw-with-anipres-shapes wrapper; the
// consumers own deployment-specific policy.
export { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
export type { SlideShape } from "./shapes/slide/SlideShape.ts";
export {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";
export type {
  ThemeDimension,
  ThemeImageShape,
  ThemeImageShapeProps,
} from "./shapes/theme-image/ThemeImageShape.ts";
export {
  youTubeEmbedShapeProps,
  YouTubeEmbedShapeType,
} from "./shapes/youtube-embed/YouTubeEmbedShape.ts";
export type {
  YouTubeEmbedShape,
  YouTubeEmbedShapeProps,
} from "./shapes/youtube-embed/YouTubeEmbedShape.ts";
export {
  mediaControlShapeProps,
  MediaControlShapeType,
} from "./shapes/media-control/MediaControlShape.ts";
export type { MediaControlShape } from "./shapes/media-control/MediaControlShape.ts";
