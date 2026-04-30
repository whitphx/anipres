import type { Hono } from "hono";
import type { AppBindings } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookies are SameSite=Lax, which blocks subresource cross-site POSTs
// but not top-level form-POST navigations and not WebSocket upgrades.
// Browsers always set `Origin` on non-safe methods and on WS upgrades,
// so a strict equality check against PUBLIC_BASE_URL closes those
// gaps without requiring a CSRF token round-trip.
export function registerCsrfGuard(app: Hono<AppBindings>) {
  app.use("*", async (c, next) => {
    const isWebSocketUpgrade =
      c.req.method === "GET" &&
      c.req.header("Upgrade")?.toLowerCase() === "websocket";

    if (SAFE_METHODS.has(c.req.method) && !isWebSocketUpgrade) {
      return next();
    }

    const origin = c.req.header("Origin");
    if (origin && origin === c.env.PUBLIC_BASE_URL) {
      return next();
    }

    return c.json({ error: "Forbidden" }, 403);
  });
}
