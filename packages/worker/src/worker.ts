import { Hono } from "hono";
import * as v from "valibot";
import { registerAssetRoutes, startDocumentDeletion } from "./assets";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import type { AppBindings } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

const app = new Hono<AppBindings>();

const documentIdParamSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
});

const documentConnectParamSchema = v.object({
  documentId: v.pipe(v.string(), v.uuid()),
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
// `deleting_at` is a real intermediate state. Once delete starts, user-facing
// routes stop treating the document as active so uploads and sync connections
// cannot race with the R2 cleanup that runs before final row removal.

// List all documents ordered by "order"
app.get("/api/documents", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    'SELECT id, title, "order", created_at, updated_at FROM documents WHERE user_id = ? AND deleting_at IS NULL ORDER BY "order" ASC',
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
    'SELECT id, title, "order", created_at, updated_at FROM documents WHERE id = ? AND user_id = ? AND deleting_at IS NULL',
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

  const { meta } = await c.env.DB.prepare(
    `INSERT INTO documents (id, title, "order", created_at, updated_at, user_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       "order" = excluded."order",
       updated_at = excluded.updated_at
     WHERE documents.user_id = excluded.user_id
       AND documents.deleting_at IS NULL`,
  )
    .bind(id, body.title, body.order, body.created_at, body.updated_at, userId)
    .run();

  if (meta.changes === 0) {
    return c.json({ error: "Not found" }, 404);
  }

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
    "SELECT deleting_at FROM documents WHERE id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .first<{ deleting_at: number | null }>();
  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  if (document.deleting_at !== null && document.deleting_at !== undefined) {
    return c.json({ ok: true });
  }

  await startDocumentDeletion(c, userId, id);
  return c.json({ ok: true });
});

// Push a snapshot from an offline client into the Durable Object room.
// Used by the push-or-fork reconnection flow after an offline editing session.
app.put("/api/documents/:id/snapshot", async (c) => {
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

  const bodyResult = v.safeParse(
    v.object({
      snapshot: v.record(v.string(), v.unknown()),
      expectedUpdatedAt: v.number(),
    }),
    json,
  );
  if (!bodyResult.success) {
    return c.json(
      { error: "Invalid request body", details: bodyResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
  const { snapshot, expectedUpdatedAt } = bodyResult.output;

  // Ownership + existence check.
  const row = await c.env.DB.prepare(
    "SELECT updated_at FROM documents WHERE id = ? AND user_id = ? AND deleting_at IS NULL",
  )
    .bind(id, userId)
    .first<{ updated_at: number }>();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }

  // Cheap pre-check on metadata. Note: live WebSocket edits do NOT bump
  // documents.updated_at (only PUT/rename/reorder do), so this only catches
  // divergence in metadata. The authoritative guard against clobbering live
  // editing happens inside the DO via getNumActiveSessions().
  if (row.updated_at > expectedUpdatedAt) {
    return c.json({ error: "Conflict", serverUpdatedAt: row.updated_at }, 409);
  }

  const doId = c.env.DOCUMENT_SYNC_ROOM.idFromName(id);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(doId);
  const replaced = await room.replaceSnapshot(id, snapshot);
  if (!replaced) {
    // Active sessions are connected — refuse to overwrite live state.
    return c.json(
      { error: "Conflict", reason: "Document has active live editing sessions" },
      409,
    );
  }

  // Bump updated_at in D1.
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE documents SET updated_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(now, id, userId)
    .run();

  return c.json({ ok: true });
});

// WebSocket upgrade for sync
app.get("/api/connect/:documentId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const userId = c.get("userId");
  const paramsResult = v.safeParse(documentConnectParamSchema, {
    documentId: c.req.param("documentId"),
  });
  if (!paramsResult.success) {
    return c.json(
      { error: "Invalid document id", details: paramsResult.issues },
      400,
    );
  }

  const { documentId } = paramsResult.output;

  const document = await c.env.DB.prepare(
    "SELECT 1 FROM documents WHERE id = ? AND user_id = ? AND deleting_at IS NULL",
  )
    .bind(documentId, userId)
    .first();

  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(documentId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);

  return room.fetch(c.req.raw);
});

export default app;
