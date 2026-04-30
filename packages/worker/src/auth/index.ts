import type { Hono } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { clearSession, getCurrentUser, requireSession } from "./session";

// `/auth/identities` GET + DELETE live in `./identities` as a chained
// sub-router so their `typeof` can be consumed by the app-side
// `hc<>()` typed client. The rest of the auth surface stays in this
// register-mutates-app form for now; we can convert it incrementally
// as more endpoints get typed-client call sites on the app side.

export function registerAuthRoutes(app: Hono<AppBindings>) {
  registerGitHubAuth(app);
  registerGoogleAuth(app);

  app.get("/auth/me", async (c) => {
    const user = await getCurrentUser(c);
    if (!user) {
      // Self-heal stale cookies: a JWT can outlive its underlying
      // user row (DB reset in dev, or an account deletion once that
      // ships). Without this, the browser keeps replaying the orphan
      // cookie on every load — `getCurrentUser` returns null, the
      // client stays in a logged-out state with a still-present
      // cookie, and the next OAuth attempt would land in link mode
      // against a missing user (now caught in `session.ts`, but the
      // cookie itself is the root cause and worth clearing here).
      // Safe to call unconditionally: when there's no cookie or the
      // signature failed, `clearSession` is a no-op for the client.
      clearSession(c);
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
