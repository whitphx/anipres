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

registerOAuthProviderRoutes(app);
// Must mount before the /api/* sub-routers below — Hono runs
// middleware that matches a request's path in registration order.
registerApiAuth(app);

// `typeof routes` is the type the app's `hc<>` client consumes;
// each `.route()` extends that type with its sub-router's schema.
const routes = app
  .route("/", authRoutes)
  .route("/", workspacesRoutes)
  .route("/", documentsRoutes)
  .route("/", assetRoutes)
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
