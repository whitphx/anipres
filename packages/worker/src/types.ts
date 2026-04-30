import type { Context } from "hono";
import type { DocumentSyncRoom } from "./DocumentSyncRoom";

export interface Env {
  DOCUMENT_SYNC_ROOM: DurableObjectNamespace<DocumentSyncRoom>;
  DB: D1Database;
  GITHUB_ID: string;
  GITHUB_SECRET: string;
  GOOGLE_ID: string;
  GOOGLE_SECRET: string;
  JWT_SECRET: string;
  /**
   * The public-facing origin (no trailing slash). Used to construct
   * external-facing URLs the worker emits — currently the Google
   * OAuth `redirect_uri`, which must match a value registered in the
   * Google Cloud Console exactly.
   *
   * Per-environment values:
   * - prod:    `https://anipres.app`
   * - preview: `https://<preview-worker>.<account>.workers.dev`
   * - dev:     `http://localhost:5173` (the Vite dev origin Vite
   *            proxies to wrangler at 8787)
   *
   * Set via `[vars]` in `wrangler.toml` for prod / preview, and via
   * `.dev.vars` for local dev. Deliberately a plain var (not a
   * secret) since the value isn't sensitive.
   */
  PUBLIC_BASE_URL: string;
  ASSETS: R2Bucket;
}

export type Variables = {
  userId: number;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};

export type AppContext = Context<AppBindings>;
