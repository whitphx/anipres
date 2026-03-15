import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { githubAuth } from "@hono/oauth-providers/github";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

interface Env {
  DOCUMENT_SYNC_ROOM: DurableObjectNamespace;
  DB: D1Database;
  GITHUB_ID: string;
  GITHUB_SECRET: string;
  JWT_SECRET: string;
}

type Variables = {
  userId: number;
};

const COOKIE_NAME = "anipres_session";
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// --- Auth routes ---

app.use(
  "/auth/github",
  githubAuth({
    scope: ["user:email"],
    oauthApp: true,
  }),
);

app.get("/auth/github", async (c) => {
  const ghUser = c.get("user-github");

  if (!ghUser) {
    return c.text("Authentication failed", 401);
  }

  const now = Math.floor(Date.now() / 1000);

  // Upsert user
  await c.env.DB.prepare(
    `INSERT INTO users (provider, provider_id, created_at)
     VALUES ('github', ?, ?)
     ON CONFLICT(provider, provider_id) DO NOTHING`,
  )
    .bind(
      String(ghUser.id),
      now,
    )
    .run();

  // Get user id
  const user = await c.env.DB.prepare(
    "SELECT id FROM users WHERE provider = 'github' AND provider_id = ?",
  )
    .bind(String(ghUser.id))
    .first<{ id: number }>();

  if (!user) {
    return c.text("Failed to create user", 500);
  }

  // Issue JWT
  const jwt = await sign(
    {
      sub: user.id,
      exp: now + JWT_EXPIRY_SECONDS,
      iat: now,
    },
    c.env.JWT_SECRET,
  );

  setCookie(c, COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: JWT_EXPIRY_SECONDS,
  });

  return c.redirect("/");
});

app.get("/auth/me", async (c) => {
  const jwt = getCookie(c, COOKIE_NAME);
  if (!jwt) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const payload = await verify(jwt, c.env.JWT_SECRET, "HS256");
    const userId = payload.sub as number;

    const user = await c.env.DB.prepare(
      "SELECT id, provider FROM users WHERE id = ?",
    )
      .bind(userId)
      .first();

    if (!user) {
      return c.json({ error: "User not found" }, 401);
    }

    return c.json(user);
  } catch {
    return c.json({ error: "Invalid session" }, 401);
  }
});

app.post("/auth/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
  return c.json({ ok: true });
});

// --- Auth middleware for /api/* ---

app.use("/api/*", async (c, next) => {
  const jwt = getCookie(c, COOKIE_NAME);
  if (!jwt) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  try {
    const payload = await verify(jwt, c.env.JWT_SECRET, "HS256");
    c.set("userId", payload.sub as number);
  } catch {
    return c.json({ error: "Invalid session" }, 401);
  }

  await next();
});

// --- Document routes (user-scoped) ---

// List all documents ordered by "order"
app.get("/api/documents", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, "order", created_at, updated_at FROM documents WHERE user_id = ? ORDER BY "order" ASC',
  )
    .bind(userId)
    .all();
  return c.json(results);
});

// Get a single document (metadata only; snapshot is null)
app.get("/api/documents/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    'SELECT id, title, "order", created_at, updated_at FROM documents WHERE id = ? AND user_id = ?',
  )
    .bind(id, userId)
    .first();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ meta: row, snapshot: null });
});

// Upsert document metadata
app.put("/api/documents/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<{
    title: string;
    order: number;
    created_at: number;
    updated_at: number;
  }>();

  await c.env.DB.prepare(
    `INSERT INTO documents (id, title, "order", created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       "order" = excluded."order",
       updated_at = excluded.updated_at
     WHERE documents.user_id = excluded.user_id`,
  )
    .bind(id, body.title, body.order, body.created_at, body.updated_at, userId)
    .run();

  return c.json({ ok: true });
});

// Delete a document
app.delete("/api/documents/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return c.json({ ok: true });
});

// WebSocket upgrade for sync
app.get("/api/connect/:roomId", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const roomId = c.req.param("roomId");
  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(roomId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);

  return room.fetch(c.req.raw);
});

export default app;
