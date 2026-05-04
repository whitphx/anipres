/**
 * Asset-upload limits. The worker is the canonical source — it's
 * where the limit is *enforced* (the upload route rejects oversized
 * files with 413). The app imports the same constant via the worker
 * package's `exports` map so the tldraw editor (`maxAssetSize` prop)
 * rejects oversized files at drag/drop time, before the user finds
 * out the upload would be rejected. The dependency direction
 * (app → worker) is unusual but here we're sharing a constant, not
 * code: the worker package is imported only for this module, and
 * the app's bundler tree-shakes the rest.
 */

export const MAX_ASSET_SIZE = 10 * 1024 * 1024;
