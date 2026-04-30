import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { requireSession } from "./session";

// Non-route helpers for the auth surface. The actual JSON `/auth/*`
// routes (me, logout, identities) are defined as a chained Hono
// sub-router in `../routes/auth.ts` per the routes/<url-segment>.ts
// convention. The exports here are register-mutates-app helpers for
// concerns that *aren't* JSON routes:
//
// - `registerOAuthProviderRoutes`: mounts `/auth/github/*` and
//   `/auth/google/*` browser-redirect handlers. These aren't fetched
//   by the app so they're outside the typed-RPC chain.
// - `registerApiAuth`: attaches the `/api/*` JWT-cookie middleware
//   that populates `c.var.userId`.

export function registerOAuthProviderRoutes(app: Hono<AppBindings>) {
  registerGitHubAuth(app);
  registerGoogleAuth(app);
}

export function registerApiAuth(app: Hono<AppBindings>) {
  app.use("/api/*", async (c, next) => {
    const userId = await requireSession(c);
    if (userId === null) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    c.set("userId", userId);
    await next();
  });
}
