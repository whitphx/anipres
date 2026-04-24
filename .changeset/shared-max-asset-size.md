---
"anipres": minor
---

Export `MAX_ASSET_SIZE` from `anipres/schema` and pass it through to the underlying `<Tldraw>` component as the `maxAssetSize` prop, so the editor rejects oversized files at drag/drop time with a friendly toast. The constant is shared with the anipres worker's asset upload endpoint to keep the client and server caps in sync.
