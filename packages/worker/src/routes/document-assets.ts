// `/api/documents/:id/assets*` lives here per the routes/<top-level-
// url-segment>.ts convention. The chained sub-router itself stays
// defined in `../tldraw-assets.ts` next to its ~15 internal helpers
// (multipart parsing, R2 keying, GC scheduling, range-request math,
// content-type allowlisting). Inlining the handlers here would force
// every one of those helpers to become a public export of
// `tldraw-assets.ts`, trading a small navigation hop for a much
// larger public surface — not worth it. This file is a re-export
// shim so the URL→file rule still resolves: anyone looking for
// `/api/documents/:id/assets*` opens this file first and is one hop
// away from the actual handlers.
export { assetRoutes, type AssetRoutes } from "../tldraw-assets";
