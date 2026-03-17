import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Hono } from "hono";
import type { AppBindings, AppContext } from "../types";
import { upsertUserAndIssueSession } from "./session";

const GOOGLE_STATE_COOKIE_NAME = "anipres_google_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

function getGoogleRedirectUri(c: AppContext) {
  return new URL(GOOGLE_CALLBACK_PATH, c.req.url).toString();
}

async function exchangeCodeForAccessToken(c: AppContext, code: string) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_ID,
      client_secret: c.env.GOOGLE_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: getGoogleRedirectUri(c),
    }),
  });

  if (!tokenResponse.ok) {
    return null;
  }

  const token = (await tokenResponse.json()) as { access_token?: string };
  return token.access_token ?? null;
}

async function fetchGoogleUserSub(accessToken: string) {
  const userResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!userResponse.ok) {
    return null;
  }

  const googleUser = (await userResponse.json()) as { sub?: string };
  return googleUser.sub ?? null;
}

function clearGoogleStateCookie(c: AppContext) {
  deleteCookie(c, GOOGLE_STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: GOOGLE_CALLBACK_PATH,
  });
}

export function registerGoogleAuth(app: Hono<AppBindings>) {
  // Google is handled manually because @hono/oauth-providers@0.8.5 posts an
  // incompatible token payload, and a provider-specific state cookie avoids
  // cross-provider collisions when multiple OAuth flows run concurrently.
  app.get("/auth/google", async (c) => {
    const state = crypto.randomUUID();
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", c.env.GOOGLE_ID);
    authUrl.searchParams.set("redirect_uri", getGoogleRedirectUri(c));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("state", state);

    setCookie(c, GOOGLE_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: GOOGLE_CALLBACK_PATH,
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });

    return c.redirect(authUrl.toString());
  });

  app.get(GOOGLE_CALLBACK_PATH, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, GOOGLE_STATE_COOKIE_NAME);

    clearGoogleStateCookie(c);

    if (!code || !state || !storedState || state !== storedState) {
      return c.text("Authentication failed", 401);
    }

    const accessToken = await exchangeCodeForAccessToken(c, code);
    if (!accessToken) {
      return c.text("Authentication failed", 401);
    }

    const googleUserSub = await fetchGoogleUserSub(accessToken);
    if (!googleUserSub) {
      return c.text("Authentication failed", 401);
    }

    return upsertUserAndIssueSession(c, "google", googleUserSub);
  });
}
