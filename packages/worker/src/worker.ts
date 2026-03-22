import { Hono } from "hono";
import * as v from "valibot";
import { deleteDocumentAndAssets, registerAssetRoutes } from "./assets";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import type { AppBindings } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

const app = new Hono<AppBindings>();

const documentIdParamSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
});

const roomIdParamSchema = v.object({
  roomId: v.pipe(v.string(), v.uuid()),
});

const documentMetadataSchema = v.object({
  title: v.string(),
  order: v.number(),
  created_at: v.number(),
  updated_at: v.number(),
});

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
  const paramsResult = v.safeParse(documentIdParamSchema, {
    id: c.req.param("id"),
  });
  if (!paramsResult.success) {
    return c.json(
      { error: "Invalid document id", details: paramsResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
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
  const paramsResult = v.safeParse(documentIdParamSchema, {
    id: c.req.param("id"),
  });
  if (!paramsResult.success) {
    return c.json(
      { error: "Invalid document id", details: paramsResult.issues },
      400,
    );
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const bodyResult = v.safeParse(documentMetadataSchema, json);
  if (!bodyResult.success) {
    return c.json(
      { error: "Invalid document metadata", details: bodyResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
  const body = bodyResult.output;

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
  const paramsResult = v.safeParse(documentIdParamSchema, {
    id: c.req.param("id"),
  });
  if (!paramsResult.success) {
    return c.json(
      { error: "Invalid document id", details: paramsResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
  const document = await c.env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .first();
  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  await deleteDocumentAndAssets(c, userId, id);
  return c.json({ ok: true });
});

// WebSocket upgrade for sync
app.get("/api/connect/:roomId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const userId = c.get("userId");
  const paramsResult = v.safeParse(roomIdParamSchema, {
    roomId: c.req.param("roomId"),
  });
  if (!paramsResult.success) {
    return c.json(
      { error: "Invalid room id", details: paramsResult.issues },
      400,
    );
  }

  const { roomId } = paramsResult.output;

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
