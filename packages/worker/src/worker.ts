import { Hono } from "hono";
import { registerApiAuth, registerOAuthProviderRoutes } from "./auth";
import { sweepInitializingDocuments } from "./cleanup";
import { authRoutes } from "./routes/auth";
import { connectRoutes } from "./routes/connect";
import { documentsRoutes } from "./routes/documents";
import { assetRoutes } from "./routes/document-assets";
import { workspacesRoutes } from "./routes/workspaces";
import type { AppBindings, Env } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

// Concrete route definitions live under `./routes/<url>.ts`, keyed
// by their top-level URL segment. To add an endpoint: add it to the
// matching sub-router (or create a new file under `routes/` for a
// fresh URL prefix), then chain `.route("/", newRouter)` below so
// its types flow into `AppType`.

const app = new Hono<AppBindings>();

// Side-effect mutations: OAuth provider redirects (browser-only, no
// app-side fetch — kept off the typed chain) and the `/api/*` auth
// middleware. Order matters at runtime: middleware must be registered
// before the sub-routers it gates.
registerOAuthProviderRoutes(app);
registerApiAuth(app);

// `typeof routes` is what the app's `hc<AppType>(...)` client
// consumes. Each `.route("/", ...)` adds its sub-router's routes to
// the cumulative type.
const routes = app
  .route("/", authRoutes)
  .route("/", workspacesRoutes)
  .route("/", documentsRoutes)
  .route("/", assetRoutes)
  // The websocket route is mounted into the chain too — its handler
  // returns a raw `Response`, which is fine to include in the type
  // (the typed client just sees a non-JSON response). Keeps the
  // routes/<url>.ts convention symmetric.
  .route("/", connectRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const { reconciledCount, deletedCount } =
            await sweepInitializingDocuments(env);
          if (reconciledCount > 0 || deletedCount > 0) {
            console.log(
              `[scheduled] Initializing-doc sweep: reconciled ${reconciledCount}, deleted ${deletedCount}.`,
            );
          }
        } catch (error) {
          console.error("[scheduled] Sweep failed:", error);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
