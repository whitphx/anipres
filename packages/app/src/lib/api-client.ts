import { hc } from "hono/client";
import type { IdentitiesRoutes } from "anipres-worker/auth/identities";

// Typed RPC client for the worker's `/auth/identities` sub-router.
// Path/param shapes and per-status response types come from the
// chained route definitions in the worker package — refactor a server
// signature and the call sites here surface compile errors instead of
// runtime drift.
//
// `/` base means the client uses relative URLs: in dev Vite proxies
// `/auth/*` and `/api/*` to wrangler at :8787; in prod the worker
// serves the bundled SPA from the same origin. Keep a single client
// instance so the SWR cache keys (the `["auth", "identities"]` tuple
// below) remain stable across renders.
//
// Scope note: this is a sketch. As more endpoints get typed call
// sites, either grow this client to cover them (`hc<AppType>(...)`
// over the full app) or add a sibling client per sub-router. The
// current import surface (`anipres-worker/auth/identities`) keeps
// the touched API surface narrow.
export const apiClient = hc<IdentitiesRoutes>("/");
