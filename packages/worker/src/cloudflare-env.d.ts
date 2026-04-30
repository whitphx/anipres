// Bridge our app `Env` (from `./types`) into the ambient
// `Cloudflare.Env` (used by `cloudflare:test`) and the global
// `Env` (used by `cloudflare:workers`'s `env`) so DO test code
// sees the same shape as application code.
import type { Env as AppEnv } from "./types";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
  interface Env extends AppEnv {}
}
