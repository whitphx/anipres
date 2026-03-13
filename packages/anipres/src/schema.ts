// This file is a separate ESM entry point ("anipres/schema") that only
// re-exports pure-TS shape props and type constants — no React, no ShapeUtils.
// This allows non-React consumers like the Cloudflare Worker to import shape
// schemas without pulling in the React component tree from the main entry.
export { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
export {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";
