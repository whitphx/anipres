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

  const user = await c.env.DB.prepare(
    `INSERT INTO users (provider, provider_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(provider, provider_id) DO UPDATE SET provider = provider
     RETURNING id`,
  )
    .bind(provider, providerId, now)
    .first<{ id: number }>();

  if (!user) {
    return c.text("Failed to create user", 500);
  }

  const jwt = await sign(
    {
      sub: String(user.id),
      exp: now + JWT_EXPIRY_SECONDS,
      iat: now,
    },
    c.env.JWT_SECRET,
  );

  setSessionCookie(c, jwt);
  return c.redirect("/");
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

  const user = await c.env.DB.prepare(
    "SELECT id, provider FROM users WHERE id = ?",
  )
    .bind(userId)
    .first();

  if (!user) {
    return null;
  }

  return user;
}
