import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { registerApiAuth, registerOAuthProviderRoutes } from "./auth";
import { sweepInitializingDocuments } from "./cleanup";
import { agentRoutes } from "./routes/agent";
import { authRoutes } from "./routes/auth";
import { connectRoutes } from "./routes/connect";
import { documentsRoutes } from "./routes/documents";
import { assetRoutes } from "./routes/document-assets";
import { workspacesRoutes } from "./routes/workspaces";
import type { AppBindings, Env } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";
export { WorkspaceFeedRoom } from "./WorkspaceFeedRoom";

const app = new Hono<AppBindings>();

app.use(
  "*",
  csrf({ origin: (origin, c) => origin === c.env.PUBLIC_BASE_URL }),
);
registerOAuthProviderRoutes(app);
// Must mount before the /api/* sub-routers below — Hono runs
// middleware that matches a request's path in registration order.
registerApiAuth(app);

// Capture the chained type so `AppType` reflects every sub-router's
// schema for the typed RPC client.
const routes = app
  .route("/", authRoutes)
  .route("/", workspacesRoutes)
  .route("/", documentsRoutes)
  .route("/", assetRoutes)
  .route("/", connectRoutes)
  .route("/", agentRoutes);

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
