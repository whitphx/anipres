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
// serves the bundled SPA from the same origin. Keep a single client
// instance so SWR cache keys remain stable across renders.
//
// The `AppType` import is type-only: the runtime worker code never
// reaches the browser (the app bundles its own client code). At
// compile time, TypeScript walks the type, which transitively
// requires `@cloudflare/workers-types` to be ambient — see the
// comment in `tsconfig.app.json` for why.
export const apiClient = hc<AppType>("/");
