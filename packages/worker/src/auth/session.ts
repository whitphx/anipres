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

export async function upsertUserAndIssueSession(
  c: AppContext,
  provider: string,
  providerId: string,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  const userId = await resolveUserIdForOAuthIdentity(c, provider, providerId);
  if (userId === null) {
    return c.text("Failed to create user", 500);
  }

  const jwt = await sign(
    {
      sub: String(userId),
      exp: now + JWT_EXPIRY_SECONDS,
      iat: now,
    },
    c.env.JWT_SECRET,
  );

  setSessionCookie(c, jwt);
  return c.redirect("/");
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

  // Phase 1: each user has exactly one identity, so picking the
  // earliest-attached one is unambiguous. When account-linking lands
  // (`docs/TODO.md`), this should return all identities or the user's
  // designated primary.
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
