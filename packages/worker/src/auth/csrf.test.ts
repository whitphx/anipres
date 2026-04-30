import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../types";
import { registerCsrfGuard } from "./csrf";

const PUBLIC_BASE_URL = "https://anipres.app";

function buildApp() {
  const app = new Hono<AppBindings>();
  registerCsrfGuard(app);
  app.get("/api/safe", (c) => c.json({ ok: true }));
  app.post("/api/mut", (c) => c.json({ ok: true }));
  app.get("/api/connect/:id", (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
      return c.json({ ok: true });
    }
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  });
  return app;
}

function dispatch(
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  return buildApp().request(
    new Request(`${PUBLIC_BASE_URL}${path}`, { method, headers }),
    {},
    { PUBLIC_BASE_URL } as AppBindings["Bindings"],
  );
}

describe("registerCsrfGuard", () => {
  it("allows safe-method requests with no Origin header", async () => {
    const res = await dispatch("GET", "/api/safe");
    expect(res.status).toBe(200);
  });

  it("allows POST when Origin matches PUBLIC_BASE_URL", async () => {
    const res = await dispatch("POST", "/api/mut", {
      Origin: PUBLIC_BASE_URL,
    });
    expect(res.status).toBe(200);
  });

  it("rejects POST when Origin does not match PUBLIC_BASE_URL", async () => {
    const res = await dispatch("POST", "/api/mut", {
      Origin: "https://attacker.example",
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with no Origin header", async () => {
    const res = await dispatch("POST", "/api/mut");
    expect(res.status).toBe(403);
  });

  it("rejects POST with Origin: null (sandboxed iframes)", async () => {
    const res = await dispatch("POST", "/api/mut", { Origin: "null" });
    expect(res.status).toBe(403);
  });

  it("allows WebSocket upgrade when Origin matches", async () => {
    const res = await dispatch("GET", "/api/connect/abc", {
      Origin: PUBLIC_BASE_URL,
      Upgrade: "websocket",
    });
    expect(res.status).toBe(200);
  });

  it("rejects WebSocket upgrade when Origin does not match", async () => {
    const res = await dispatch("GET", "/api/connect/abc", {
      Origin: "https://attacker.example",
      Upgrade: "websocket",
    });
    expect(res.status).toBe(403);
  });

  it("rejects WebSocket upgrade with no Origin", async () => {
    const res = await dispatch("GET", "/api/connect/abc", {
      Upgrade: "websocket",
    });
    expect(res.status).toBe(403);
  });
});
