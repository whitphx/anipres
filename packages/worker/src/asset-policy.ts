/**
 * Asset-upload policy values. The worker is the canonical source —
 * it's where the limit is *enforced* (the upload route rejects
 * oversized files with 413). The app imports the same constant via
 * the workspace `exports` map below to keep its UI in sync (the
 * tldraw editor's `maxAssetSize` prop), so a user doesn't drop a
 * file the editor accepts only to see the upload rejected.
 *
 * Exposed via `exports["./asset-policy"]` in `packages/worker/package.json`.
 * The dependency direction (app → worker) is unusual for a typical
 * client/server split, but here we're sharing a constant, not code:
 * the worker package is imported only for its constants module, and
 * the app's bundler tree-shakes everything else.
 */

/**
 * Maximum size in bytes for a single uploaded asset (image or video).
 *
 * - The client passes this to tldraw as `maxAssetSize` so the editor
 *   rejects oversized files at drag/drop time.
 * - The worker enforces it on `POST /api/documents/:id/assets`.
 */
export const MAX_ASSET_SIZE = 10 * 1024 * 1024;
