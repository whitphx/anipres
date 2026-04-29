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
  // Prefer the configured `PUBLIC_BASE_URL` env var. Set in
  // `wrangler.toml`'s `[vars]` (prod) and `[env.preview.vars]`
  // (preview); not derived from request context because
  // `c.req.url` reports the production route pattern (`anipres.app`)
  // even under `wrangler dev`, and a request-derived URI would also
  // depend on Cloudflare's Host-routing trust chain.
  if (c.env.PUBLIC_BASE_URL) {
    return `${c.env.PUBLIC_BASE_URL}${GOOGLE_CALLBACK_PATH}`;
  }

  // Local-dev fallback: when the env var is unset AND the request's
  // Host is loopback (`localhost` / `127.0.0.1`), construct from the
  // Host header so a fresh dev environment doesn't need a
  // `.dev.vars` edit before Google login works.
  //
  // Bounded to loopback hosts: in production behind Cloudflare,
  // a request can only reach this worker if its Host matches a
  // configured route binding. None of those are loopback, so this
  // branch is unreachable in prod and the fallback can't influence
  // a deployed redirect_uri.
  const host = c.req.header("host");
  // Diagnostic log — helps confirm what Host the worker sees under
  // a particular `wrangler dev` + Vite proxy setup. Vite preserves
  // Host by default (changeOrigin=false), but the value depends on
  // the local config and we want this fallback path observable.
  console.error(`[google-auth] fallback path; host header=${host}`);
  if (host && isLocalhostHost(host)) {
    return `http://${host}${GOOGLE_CALLBACK_PATH}`;
  }

  // Production miss — env var unset and Host isn't loopback. Log
  // and return a clearly-bogus URI that Google will reject in a
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
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", c.env.GOOGLE_ID);
    authUrl.searchParams.set("redirect_uri", getGoogleRedirectUri(c));
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
