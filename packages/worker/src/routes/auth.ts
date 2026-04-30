import { Hono } from "hono";
import * as v from "valibot";
import {
  clearSession,
  getCurrentUser,
  listOAuthIdentities,
  requireSession,
  revokeOAuthIdentity,
} from "../auth/session";
import { oauthIdentityRevokeParamSchema } from "../schemas";
import type { AppBindings } from "../types";

// All JSON endpoints under `/auth/*` as a single chained sub-router.
// `typeof authRoutes` flows into the worker's combined `AppType` so
// the app's `apiClient.auth.*` reaches every route here.
//
// OAuth provider routes (`/auth/github/*`, `/auth/google/*`) are
// browser-redirect endpoints registered separately by
// `registerOAuthProviderRoutes` — the app never `fetch()`es them, so
// they don't need typed-RPC plumbing.
export const authRoutes = new Hono<AppBindings>()
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
  })
  // List the OAuth identities linked to the current user. Used by the
  // account-settings UI to render the "linked providers" panel and
  // gate the "Connect another" buttons. 401 when logged out — the
  // settings UI is only reachable from a logged-in surface anyway.
  .get("/auth/identities", async (c) => {
    const userId = await requireSession(c);
    if (userId === null) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const identities = await listOAuthIdentities(c, userId);
    return c.json(identities, 200);
  })
  // Detach an OAuth identity from the current user (the unlink
  // counterpart to the `/auth/{provider}` connect flow). 409 with
  // `code: "last_identity"` when refused — the server-side guard
  // refuses to leave a user with zero identities (which would lock
  // them out, since login resolves users via `(provider,
  // provider_id)`). The settings UI hides the Unlink button when
  // there's only one identity, but the server check is the actual
  // safety guarantee.
  .delete("/auth/identities/:provider/:provider_id", async (c) => {
    const userId = await requireSession(c);
    if (userId === null) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    const paramsResult = v.safeParse(oauthIdentityRevokeParamSchema, {
      provider: c.req.param("provider"),
      provider_id: c.req.param("provider_id"),
    });
    if (!paramsResult.success) {
      return c.json(
        { error: "Invalid identity", details: paramsResult.issues },
        400,
      );
    }
    const { provider, provider_id } = paramsResult.output;
    const outcome = await revokeOAuthIdentity(c, userId, provider, provider_id);
    if (outcome === "revoked") {
      return c.json({ ok: true as const }, 200);
    }
    if (outcome === "last_identity") {
      return c.json(
        {
          error: "Cannot remove your last sign-in method.",
          code: "last_identity" as const,
        },
        409,
      );
    }
    return c.json({ error: "Not found" }, 404);
  });

export type AuthRoutes = typeof authRoutes;
