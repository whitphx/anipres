import { Hono } from "hono";
import type { Hono as HonoType } from "hono";
import type { AppBindings } from "../types";
import { registerGitHubAuth } from "./github";
import { registerGoogleAuth } from "./google";
import { clearSession, getCurrentUser, requireSession } from "./session";

// OAuth provider routes (`/auth/github/*`, `/auth/google/*`) are
// browser-redirect endpoints — the app never `fetch()`es them, so
// they don't need typed-RPC plumbing. Kept as register-mutates-app.
export function registerOAuthProviderRoutes(app: HonoType<AppBindings>) {
  registerGitHubAuth(app);
  registerGoogleAuth(app);
}

// `/auth/me` and `/auth/logout` as a chained Hono sub-router. The
// chain's `typeof` flows through the worker's combined `AppType` so
// the app's typed `apiClient` picks them up. Status literals are
// always passed to `c.json(...)` (e.g. `c.json(user, 200)`) so the
// client can narrow `res.json()` per status code.
export const authMeAndLogoutRoutes = new Hono<AppBindings>()
  .get("/auth/me", async (c) => {
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

    return c.json(user, 200);
  })
  .post("/auth/logout", (c) => {
    clearSession(c);
    return c.json({ ok: true as const }, 200);
  });

export function registerApiAuth(app: HonoType<AppBindings>) {
  app.use("/api/*", async (c, next) => {
    const userId = await requireSession(c);
    if (userId === null) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    c.set("userId", userId);
    await next();
  });
}
