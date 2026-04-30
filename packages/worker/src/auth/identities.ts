import { Hono } from "hono";
import * as v from "valibot";
import { oauthIdentityRevokeParamSchema } from "../schemas";
import type { AppBindings } from "../types";
import {
  listOAuthIdentities,
  requireSession,
  revokeOAuthIdentity,
} from "./session";

// Chained Hono route definition. Each `.get(...).delete(...)` call
// returns the builder typed with the cumulative route shape, so
// `typeof identitiesRoutes` carries the full path/param/response
// signature. That `typeof` is what the app-side `hc<typeof
// identitiesRoutes>(...)` client uses to derive its method names,
// path-param shapes, and `r.json()` return types — refactoring a
// signature here surfaces a compile error at the call site rather
// than at runtime.
export const identitiesRoutes = new Hono<AppBindings>()
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
    return c.json(identities);
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
      return c.json({ ok: true as const });
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

export type IdentitiesRoutes = typeof identitiesRoutes;
