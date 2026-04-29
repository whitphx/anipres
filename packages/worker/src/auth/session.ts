import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { AppContext } from "../types";

const SESSION_COOKIE_NAME = "anipres_session";
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Whether the current request is HTTPS. Used to gate the `secure`
 * cookie attribute: production runs through Cloudflare on HTTPS, so
 * it returns `true` and cookies are secure-only as expected. Local
 * `wrangler dev` (and `vite dev` proxying to it) runs over HTTP, so
 * it returns `false` and the cookies are accepted on `localhost`.
 *
 * Without this, the `secure: true` attribute would cause the browser
 * to drop the cookie on HTTP origins (Chrome's "localhost is a
 * secure context" rule isn't honored uniformly across browsers /
 * versions for cookie storage, so relying on it is fragile).
 */
export function isSecureRequest(c: AppContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function setSessionCookie(c: AppContext, jwt: string) {
  setCookie(c, SESSION_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: JWT_EXPIRY_SECONDS,
  });
}

export function clearSession(c: AppContext) {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
  });
}

/**
 * Resolve the post-OAuth-callback action.
 *
 * Two modes, distinguished only by whether the caller already has a
 * valid session cookie:
 *
 * - **Login** (no session): existing flow — find or create the user
 *   keyed by `(provider, provider_id)`, issue a fresh session cookie,
 *   redirect to `/`.
 * - **Link** (session present): attach this `(provider, provider_id)`
 *   to the existing user. The session cookie stays as-is. Redirect
 *   carries a query param so the client can surface the result.
 *
 * The session cookie *is* the intent — the production UI never sends
 * a logged-in user through OAuth except via the settings "Connect"
 * button, so "logged-in user completes the OAuth dance" is
 * unambiguously a link operation. A separate intent cookie was
 * considered but adds plumbing without buying anything.
 */
export async function upsertUserAndIssueSession(
  c: AppContext,
  provider: string,
  providerId: string,
): Promise<Response> {
  const currentUserId = await requireSession(c);
  if (currentUserId !== null) {
    return attachIdentityToCurrentUser(c, currentUserId, provider, providerId);
  }

  const userId = await resolveUserIdForOAuthIdentity(c, provider, providerId);
  if (userId === null) {
    return c.text("Failed to create user", 500);
  }

  const jwt = await issueSessionJwt(c, userId);
  setSessionCookie(c, jwt);
  return c.redirect("/");
}

async function issueSessionJwt(
  c: AppContext,
  userId: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: String(userId),
      exp: now + JWT_EXPIRY_SECONDS,
      iat: now,
    },
    c.env.JWT_SECRET,
  );
}

/**
 * Attach `(provider, provider_id)` to the currently-logged-in user.
 *
 * Three outcomes:
 *
 * - **Fresh attach** — INSERT succeeds. Identity now belongs to the
 *   current user. Redirect with `?account_link=success`.
 * - **Idempotent re-attach** — INSERT trips the `(provider,
 *   provider_id)` PK and the existing row's `user_id` matches the
 *   current user. The user re-clicked Connect on something already
 *   linked; treat as a no-op success. Redirect with
 *   `?account_link=already_linked`.
 * - **Conflict** — INSERT trips the PK and the existing row's
 *   `user_id` is *another* user. The provider account belongs to
 *   someone else; we don't auto-merge here (see TODO.md). Redirect
 *   with `?account_link_error=identity_in_use`.
 */
async function attachIdentityToCurrentUser(
  c: AppContext,
  currentUserId: number,
  provider: string,
  providerId: string,
): Promise<Response> {
  try {
    await c.env.DB.prepare(
      "INSERT INTO oauth_identities (user_id, provider, provider_id) VALUES (?, ?, ?)",
    )
      .bind(currentUserId, provider, providerId)
      .run();
    return c.redirect("/?account_link=success");
  } catch {
    // The PK trip is the dominant case; any other DB error also lands
    // here. Distinguish by re-reading the row: if it exists and points
    // at the current user, we're idempotent; if it points elsewhere,
    // surface the conflict; if it doesn't exist at all, the original
    // error wasn't a PK trip — surface a generic failure.
    const existing = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_id = ?",
    )
      .bind(provider, providerId)
      .first<{ user_id: number }>();

    if (!existing) {
      return c.redirect("/?account_link_error=server_error");
    }
    if (existing.user_id === currentUserId) {
      return c.redirect("/?account_link=already_linked");
    }
    return c.redirect("/?account_link_error=identity_in_use");
  }
}

// Look up the user_id for a given (provider, provider_id), creating
// the user record (and their personal workspace, per the Phase 1
// 1:1 invariant) on first sight. On a parallel-login race two workers
// can both observe "no identity yet" and both attempt to insert; the
// loser's INSERT into oauth_identities trips the (provider,
// provider_id) PK. The catch path deletes the orphan user — the
// workspace cascades away via `workspaces.owner_user_id ON DELETE
// CASCADE` — and re-selects to get the canonical user_id.
async function resolveUserIdForOAuthIdentity(
  c: AppContext,
  provider: string,
  providerId: string,
): Promise<number | null> {
  const existing = await c.env.DB.prepare(
    "SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_id = ?",
  )
    .bind(provider, providerId)
    .first<{ user_id: number }>();
  if (existing) {
    return existing.user_id;
  }

  const newUser = await c.env.DB.prepare(
    "INSERT INTO users DEFAULT VALUES RETURNING id",
  ).first<{ id: number }>();
  if (!newUser) {
    return null;
  }

  try {
    // Phase 1 invariant: every user has a 1:1 personal workspace.
    // Created eagerly here so the document handlers can rely on its
    // existence rather than checking on every request. The workspace
    // concept isn't user-visible yet — `'Personal'` is just an
    // internal placeholder; Extension A will let users see/rename it.
    await c.env.DB.prepare(
      "INSERT INTO workspaces (name, owner_user_id) VALUES (?, ?)",
    )
      .bind("Personal", newUser.id)
      .run();

    await c.env.DB.prepare(
      "INSERT INTO oauth_identities (user_id, provider, provider_id) VALUES (?, ?, ?)",
    )
      .bind(newUser.id, provider, providerId)
      .run();
    return newUser.id;
  } catch {
    // Either the parallel-login race tripped the identity PK, or some
    // other partial-failure mid-sequence. Roll back our just-created
    // user; the workspace (which has no documents yet, so the
    // documents.workspace_id RESTRICT is a no-op) cascades away.
    // Re-select to find the canonical user_id, or null if no winner
    // landed an identity either.
    await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
      .bind(newUser.id)
      .run();
    const winner = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_id = ?",
    )
      .bind(provider, providerId)
      .first<{ user_id: number }>();
    return winner?.user_id ?? null;
  }
}

export async function requireSession(c: AppContext): Promise<number | null> {
  const jwt = getCookie(c, SESSION_COOKIE_NAME);
  if (!jwt) {
    return null;
  }

  try {
    const payload = await verify(jwt, c.env.JWT_SECRET, "HS256");
    return Number(payload.sub);
  } catch {
    return null;
  }
}

export async function getCurrentUser(c: AppContext) {
  const userId = await requireSession(c);
  if (userId === null) {
    return null;
  }

  // `/auth/me` returns just the `id` — enough for the client to know
  // "I am logged in" and to bind workspace-scoped queries. The full
  // multi-identity state (which providers are linked) lives at
  // `GET /auth/identities` and is fetched only when the
  // account-settings UI needs it.
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
    .bind(userId)
    .first();

  if (!user) {
    return null;
  }

  return user;
}

export interface OAuthIdentitySummary {
  provider: string;
  provider_id: string;
  created_at: number;
}

/**
 * List the linked OAuth identities for `userId`, oldest-attached
 * first. Used by `GET /auth/identities` to power the account-settings
 * UI.
 */
export async function listOAuthIdentities(
  c: AppContext,
  userId: number,
): Promise<OAuthIdentitySummary[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT provider, provider_id, created_at
     FROM oauth_identities
     WHERE user_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<OAuthIdentitySummary>();
  return results;
}

export type RevokeOAuthIdentityOutcome =
  | "revoked"
  | "last_identity"
  | "not_found";

/**
 * Detach an OAuth identity from `userId`. Refuses to remove the user's
 * last identity — leaving a user with zero identities would lock them
 * out (login resolves the user via `(provider, provider_id)`, so a
 * user with no identities is unreachable). Three outcomes:
 *
 * - `"revoked"` — identity removed.
 * - `"last_identity"` — the row exists for this user but is the only
 *   one. Refused; the row stays.
 * - `"not_found"` — no row matches `(userId, provider, provider_id)`.
 *
 * The DELETE is a single atomic statement: the subquery checks the
 * count of identities for the user as part of the same statement, so
 * two concurrent revocations from the same user can't both pass the
 * check. D1 serializes writers, so the second concurrent statement
 * sees the post-first-delete count.
 */
export async function revokeOAuthIdentity(
  c: AppContext,
  userId: number,
  provider: string,
  providerId: string,
): Promise<RevokeOAuthIdentityOutcome> {
  const result = await c.env.DB.prepare(
    `DELETE FROM oauth_identities
     WHERE user_id = ?
       AND provider = ?
       AND provider_id = ?
       AND (SELECT COUNT(*) FROM oauth_identities WHERE user_id = ?) > 1`,
  )
    .bind(userId, provider, providerId, userId)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    return "revoked";
  }

  // Disambiguate: the DELETE matched zero rows either because the
  // identity doesn't exist for this user, or because it does exist
  // but it's the user's only one (the count guard rejected the
  // delete). A single SELECT distinguishes them.
  const exists = await c.env.DB.prepare(
    `SELECT 1 FROM oauth_identities
     WHERE user_id = ? AND provider = ? AND provider_id = ?`,
  )
    .bind(userId, provider, providerId)
    .first();
  return exists ? "last_identity" : "not_found";
}
