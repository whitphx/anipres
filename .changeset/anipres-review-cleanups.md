---
"anipres": minor
---

Three cleanups from PR review.

**`<Anipres>` accepts a `maxAssetSize` prop.** Previously the component hardcoded a 10 MB cap derived from a `MAX_ASSET_SIZE` constant exported from `anipres/schema`. Asset-size policy is a deployment concern (the consumer needs to keep client and server in sync), not a UI-library concern, so the constant has been removed from `anipres` and the limit is now passed in by the caller. If you don't supply `maxAssetSize`, the editor inherits tldraw's built-in default.

**`anipres/schema` no longer exports `MAX_ASSET_SIZE`.** Consumers that imported it should host it in their own deployment-policy module — for example, this repo moved it to `packages/worker` (the canonical source for server-side enforcement) and exposes it via the worker's `exports["./asset-policy"]` so the app can import the same value.

**`anipres/schema` now also exports the shape types**: `SlideShape`, `ThemeImageShape`, `ThemeImageShapeProps`, `ThemeDimension` — useful for non-React consumers that need to type their snapshot data, alongside the existing runtime exports (`slideShapeProps`, `SlideShapeType`, `themeImageShapeProps`, `ThemeImageShapeType`).

**Internal cleanup**: the pattern `<Tldraw {...(store ? { store } : { snapshot })}>` was replaced with `<Tldraw store={store} snapshot={snapshot}>`. tldraw's discriminated-union types handle the resolution; the parent now passes both props transparently and tldraw decides which initialization path to use.
