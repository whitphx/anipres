// This file is a separate ESM entry point ("anipres/schema") that only
// re-exports pure-TS shape props and type constants — no React, no ShapeUtils.
// This allows non-React consumers like the Cloudflare Worker to import shape
// schemas without pulling in the React component tree from the main entry.
export { slideShapeProps, SlideShapeType } from "./shapes/slide/SlideShape.ts";
export {
  themeImageShapeProps,
  ThemeImageShapeType,
} from "./shapes/theme-image/ThemeImageShape.ts";

/**
 * Maximum size in bytes for a single uploaded asset (image or video).
 *
 * Used by both the client (passed to tldraw as `maxAssetSize` on
 * `<Tldraw>` so the editor rejects oversized files at drag/drop time)
 * and the anipres worker (as the cap for `POST /api/documents/:id/assets`).
 *
 * Keeping the constant in this shared non-React module ensures the two
 * sides stay in sync — a bump on one side would require a bump here
 * first, and the worker's typecheck would catch drift.
 */
export const MAX_ASSET_SIZE = 10 * 1024 * 1024;
