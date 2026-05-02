import { hc } from "hono/client";
import type { AppType } from "anipres-worker/api-types";
import { CLIENT_ID, CLIENT_ID_HEADER } from "./client-id";

// `/` base — client uses relative URLs. Dev proxies API paths to
// wrangler (see `vite.config.ts`); prod serves the bundled SPA from
// the worker's own origin.
//
// The `ApiClient` alias captures the resolved client type once
// (https://hono.dev/docs/guides/rpc#typescript-project-references)
// so `tsserver` doesn't re-instantiate the large `AppType` generic
// at every call site. `AppType` itself comes from the worker's
// compiled `.d.ts` (project reference in `tsconfig.app.json`); the
// ahead-of-time `tsc -b` does the heavy instantiation work off the
// editor's hot path.
export type ApiClient = ReturnType<typeof hc<AppType>>;
export const apiClient: ApiClient = hc<AppType>("/", {
  headers: { [CLIENT_ID_HEADER]: CLIENT_ID },
});
