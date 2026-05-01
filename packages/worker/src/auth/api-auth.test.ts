import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const PUBLIC_BASE_URL = "https://anipres.app";

describe("/api/* auth gate", () => {
  it("rejects a WebSocket upgrade with no session cookie (401, not 426)", async () => {
    // The post-merge security claim for the /api/connect WS path:
    // SameSite=Lax keeps the session cookie off cross-site WS
    // upgrades initiated by JS, so the request reaches the worker
    // without a cookie and the api-auth middleware (`/api/*`)
    // returns 401 before the connect handler is invoked. This pins
    // the "401, not 426" half — the cookie-stripping half is browser
    // behavior we trust per spec.
    const documentId = "019ddd16-daf3-7503-b6b3-1dbb0d34b95e";
    const res = await SELF.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/connect/${documentId}`, {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Origin: PUBLIC_BASE_URL,
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a regular GET with no session cookie", async () => {
    const res = await SELF.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/workspaces`, {
        method: "GET",
        headers: { Origin: PUBLIC_BASE_URL },
      }),
    );
    expect(res.status).toBe(401);
  });
});
