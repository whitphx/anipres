import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { requireSession } from "./session";

// Non-route helpers for the auth surface. The JSON `/auth/*` routes
// live in `../routes/auth.ts`; the helpers here are
// register-mutates-app shims for things that aren't JSON routes
// (OAuth browser-redirect handlers, the `/api/*` auth middleware).

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
