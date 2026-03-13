import { Hono } from "hono";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

interface Env {
  DOCUMENT_SYNC_ROOM: DurableObjectNamespace;
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

// List all documents ordered by "order"
app.get("/api/documents", async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, "order", created_at, updated_at FROM documents ORDER BY "order" ASC',
  ).all();
  return c.json(results);
});

// Get a single document (metadata only; snapshot is null)
app.get("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    'SELECT id, title, "order", created_at, updated_at FROM documents WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ meta: row, snapshot: null });
});

// Upsert document metadata
app.put("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    title: string;
    order: number;
    created_at: number;
    updated_at: number;
  }>();

  await c.env.DB.prepare(
    `INSERT INTO documents (id, title, "order", created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       "order" = excluded."order",
       updated_at = excluded.updated_at`,
  )
    .bind(id, body.title, body.order, body.created_at, body.updated_at)
    .run();

  return c.json({ ok: true });
});

// Delete a document
app.delete("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
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
