import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { AppContext } from "../types";

const SESSION_COOKIE_NAME = "anipres_session";
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function setSessionCookie(c: AppContext, jwt: string) {
  setCookie(c, SESSION_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: JWT_EXPIRY_SECONDS,
  });
}

export function clearSession(c: AppContext) {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
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

  // `/auth/me` carries a single `provider` string for legacy callers
  // (the Authenticated header in the sidebar reads it as a label).
  // Picking the earliest-attached identity gives a stable answer
  // across linking events: linking a second provider doesn't flip
  // the displayed provider, only the dedicated `/auth/identities`
  // endpoint reflects the full multi-identity state.
  const user = await c.env.DB.prepare(
    `SELECT u.id AS id, oi.provider AS provider
     FROM users u
     LEFT JOIN oauth_identities oi ON oi.user_id = u.id
     WHERE u.id = ?
     ORDER BY oi.created_at ASC
     LIMIT 1`,
  )
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
