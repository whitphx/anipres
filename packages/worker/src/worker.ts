import { Hono } from "hono";
import { deleteDocumentAssetsForDocument, registerAssetRoutes } from "./assets";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import type { AppBindings } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

const app = new Hono<AppBindings>();

registerAuthRoutes(app);
registerApiAuth(app);
registerAssetRoutes(app);

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
  await deleteDocumentAssetsForDocument(c, userId, id);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return c.json({ ok: true });
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
