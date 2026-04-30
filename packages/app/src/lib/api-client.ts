import { hc } from "hono/client";
import type { AppType } from "anipres-worker/api-types";

// Typed RPC client for the worker's full HTTP surface. Path/param
// shapes and per-status response types come from the chained route
// definitions in the worker package — refactor a server signature
// and the call sites here surface compile errors instead of runtime
// drift.
//
// `/` base means the client uses relative URLs: in dev Vite proxies
// `/auth/*` and `/api/*` to wrangler at :8787; in prod the worker
// serves the bundled SPA from the same origin.
//
// `ApiClient = ReturnType<typeof hc<AppType>>` is the trick called
// out in the Hono RPC docs: capturing the resolved client type once
// here means `tsserver` doesn't re-instantiate the (large) `AppType`
// generic at every call site, which keeps IDE responsiveness fast.
// `AppType` itself comes from the worker's compiled `.d.ts`
// (project reference in `tsconfig.app.json`) — the ahead-of-time
// `tsc -b` does the heavy type-instantiation work once, off the
// editor's hot path.
export type ApiClient = ReturnType<typeof hc<AppType>>;
export const apiClient: ApiClient = hc<AppType>("/");
