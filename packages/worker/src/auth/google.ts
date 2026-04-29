import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Hono } from "hono";
import type { AppBindings, AppContext } from "../types";
import { isSecureRequest, upsertUserAndIssueSession } from "./session";

const GOOGLE_STATE_COOKIE_NAME = "anipres_google_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

function isLocalhostHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:")
  );
}

function getGoogleRedirectUri(c: AppContext) {
  // Loopback host wins over any configured `PUBLIC_BASE_URL`.
  //
  // `wrangler.toml`'s `[vars]` applies to both prod and local
  // `wrangler dev`, so without this branch a developer running
  // `wrangler dev` inherits the production URL (`https://anipres.app`)
  // and Google rejects the redirect_uri at the authorize step. When
  // the request's Host is `localhost` / `127.0.0.1`, the developer
  // is definitively on a local origin and we want to redirect back
  // to that origin — Vite's proxy preserves the browser's
  // `Host: localhost:5173`, so the result builds exactly the URI
  // the developer would have typed manually.
  //
  // Safe in prod: Cloudflare only routes a request to this worker
  // when the Host matches a configured route binding. None of those
  // are loopback, so this branch is unreachable on the deployed
  // worker — a forged loopback Host can't influence a production
  // redirect_uri.
  const host = c.req.header("host");
  if (host && isLocalhostHost(host)) {
    return `http://${host}${GOOGLE_CALLBACK_PATH}`;
  }

  // Production / preview: use the configured env var.
  if (c.env.PUBLIC_BASE_URL) {
    return `${c.env.PUBLIC_BASE_URL}${GOOGLE_CALLBACK_PATH}`;
  }

  // Misconfig: non-loopback Host AND no env var set. Log and
  // return a clearly-bogus URI that Google will reject in a
  // recognizable way ("redirect_uri_mismatch") rather than letting
  // the worker emit `undefined/auth/google/callback` silently.
  console.error(
    "[google-auth] PUBLIC_BASE_URL is not set. " +
      "Set it in `wrangler.toml`'s `[vars]` (prod) or " +
      "`[env.preview.vars]` (preview).",
  );
  return GOOGLE_CALLBACK_PATH;
}

async function exchangeCodeForAccessToken(c: AppContext, code: string) {
  const redirectUri = getGoogleRedirectUri(c);
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
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    // Surface the Google-side error body so misconfigured secrets,
    // redirect_uri mismatches, etc. produce an actionable line in the
    // worker log instead of an opaque "Authentication failed".
    const body = await tokenResponse.text().catch(() => "");
    console.error(
      `[google-auth] token exchange failed: ${tokenResponse.status} redirect_uri=${redirectUri} body=${body}`,
    );
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
    const body = await userResponse.text().catch(() => "");
    console.error(
      `[google-auth] userinfo fetch failed: ${userResponse.status} ${body}`,
    );
    return null;
  }

  const googleUser = (await userResponse.json()) as { sub?: string };
  if (!googleUser.sub) {
    console.error("[google-auth] userinfo response missing 'sub' field");
    return null;
  }
  return googleUser.sub;
}

function clearGoogleStateCookie(c: AppContext) {
  deleteCookie(c, GOOGLE_STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecureRequest(c),
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
    const redirectUri = getGoogleRedirectUri(c);
    // Diagnostic: log what we're sending to Google so any future
    // redirect_uri_mismatch is a one-glance diagnosis. Cheap line;
    // keep until the OAuth surface stabilizes for production use.
    console.log(
      `[google-auth] authorize host=${c.req.header("host")} redirect_uri=${redirectUri}`,
    );
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", c.env.GOOGLE_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("state", state);

    setCookie(c, GOOGLE_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: isSecureRequest(c),
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

    // Each branch returns the same user-facing 401 ("Authentication
    // failed") but logs a distinct reason to the worker log so a
    // misconfigured secret / mismatched redirect_uri / wedged
    // userinfo call is debuggable without re-deploying.
    if (!code || !state || !storedState || state !== storedState) {
      console.error(
        `[google-auth] state validation failed: code=${Boolean(code)} state=${Boolean(state)} storedState=${Boolean(storedState)} match=${state === storedState}`,
      );
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
