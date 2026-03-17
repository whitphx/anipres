import { Hono } from "hono";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import type { AppBindings } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

const app = new Hono<AppBindings>();

registerAuthRoutes(app);
registerApiAuth(app);

function isSupportedAssetContentType(contentType: string) {
  return contentType.startsWith("image/");
}

function isSvgContentType(contentType: string) {
  return contentType === "image/svg+xml";
}

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

// --- Asset routes ---

app.post("/api/assets", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Missing file field" }, 400);
  }
  if (!isSupportedAssetContentType(file.type)) {
    return c.json({ error: "Unsupported asset type" }, 400);
  }

  const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_ASSET_SIZE) {
    return c.json({ error: "File too large" }, 413);
  }

  const rawExt = file.name.includes(".")
    ? file.name.split(".").pop()!.toLowerCase()
    : "";
  const ext = /^[a-z0-9]+$/.test(rawExt) ? `.${rawExt}` : "";
  const key = `${crypto.randomUUID()}${ext}`;

  await c.env.ASSETS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  return c.json({ key });
});

app.get("/api/assets/:key", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.ASSETS.get(key);
  if (!object) {
    return c.json({ error: "Not found" }, 404);
  }

  const contentType =
    object.httpMetadata?.contentType ?? "application/octet-stream";
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  // This endpoint is session-protected under /api/*. Marking it `public` would
  // let a shared cache replay a response without rerunning the auth gate.
  headers.set("Cache-Control", "private, no-store");

  if (isSvgContentType(contentType)) {
    // SVG is executable when opened as a top-level same-origin document. Keep
    // SVG uploads working, but sandbox direct navigations so the asset cannot
    // run script or inherit the main app origin.
    headers.set("Content-Security-Policy", "sandbox; script-src 'none'");
  }

  return new Response(object.body, { headers });
});

// WebSocket upgrade for sync
app.get("/api/connect/:roomId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  const document = await c.env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND user_id = ?",
  )
    .bind(roomId, userId)
    .first();

  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(roomId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);

  return room.fetch(c.req.raw);
});

export default app;
