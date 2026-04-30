import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { requireSession } from "./session";

// JSON `/auth/*` routes live in `../routes/auth.ts`. The helpers
// here mutate the Hono app for concerns that don't fit the
// chained-sub-router pattern (OAuth browser-redirect routes from
// `@hono/oauth-providers`, and the `/api/*` middleware).

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
