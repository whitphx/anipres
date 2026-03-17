import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { clearSession, getCurrentUser, requireSession } from "./session";

export function registerAuthRoutes(app: Hono<AppBindings>) {
  registerGitHubAuth(app);
  registerGoogleAuth(app);

  app.get("/auth/me", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    return c.json(user);
  });

  app.post("/auth/logout", (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });
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
