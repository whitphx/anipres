import { Hono } from "hono";
import * as v from "valibot";
import { registerAssetRoutes, startDocumentDeletion } from "./assets";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import {
  documentConnectParamSchema,
  documentCreateSchema,
  documentIdParamSchema,
  documentUpdateSchema,
  MAX_SNAPSHOT_BODY_BYTES,
  snapshotPushBodySchema,
} from "./schemas";
import type { AppBindings } from "./types";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

const app = new Hono<AppBindings>();

registerAuthRoutes(app);
registerApiAuth(app);
registerAssetRoutes(app);

// --- Document routes (workspace-scoped) ---
//
// Ownership filtering goes through the user's workspace: documents
// reference `workspace_id` and the workspace records its `owner_user_id`.
// Phase 1 has a 1:1 user:workspace, so this is equivalent to the previous
// `documents.user_id` filter — but it pre-positions for Extension A
// (org-owned workspaces) without rewriting these handlers.
//
// `deleting_at` is the soft-delete intermediate state. Once delete starts,
// user-facing routes treat the document as inactive so uploads and sync
// connections cannot race with the R2 cleanup that runs before final row
// removal.
//
// Document ids are server-allocated INTEGER autoincrement values. They
// surface in JSON as decimal strings (`String(row.id)`) so the frontend
// keeps an opaque-string id type and doesn't have to worry about JSON
// number precision.

type DocumentRow = {
  id: number;
  slug: string;
  title: string;
  sort_order: string;
  created_at: number;
  updated_at: number;
};

function serializeDocumentRow(row: DocumentRow) {
  return {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Slug generator. Phase 1 doesn't surface slugs in the UI; the column is
// populated for forward compatibility. crypto.randomUUID() is overkill
// for collision avoidance but keeps the call site one line and avoids
// pulling in nanoid. We can swap to a shorter format when slugs become
// user-visible.
function generateDocumentSlug() {
  return crypto.randomUUID();
}

// List the user's active documents in sort order.
app.get("/api/documents", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.slug, d.title, d.sort_order, d.created_at, d.updated_at
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE w.owner_user_id = ? AND d.deleting_at IS NULL
     ORDER BY d.sort_order ASC`,
  )
    .bind(userId)
    .all<DocumentRow>();
  return c.json(results.map(serializeDocumentRow));
});

// Create a document. Server allocates the id (INTEGER) and the slug.
// Caller chooses the sort_order position; title and timestamps are
// optional and fall back to the column defaults.
app.post("/api/documents", async (c) => {
  const userId = c.get("userId");

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const bodyResult = v.safeParse(documentCreateSchema, json);
  if (!bodyResult.success) {
    return c.json(
      { error: "Invalid document metadata", details: bodyResult.issues },
      400,
    );
  }

  const workspace = await c.env.DB.prepare(
    "SELECT id FROM workspaces WHERE owner_user_id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ id: number }>();
  if (!workspace) {
    // The auth flow creates the user's personal workspace at signup, so
    // this should never happen for a valid session. Surface as 500 so we
    // notice if the invariant breaks.
    return c.json({ error: "No workspace for this user" }, 500);
  }

  const body = bodyResult.output;
  const slug = generateDocumentSlug();
  const now = Date.now();

  // `created_at` honors the optional client override (used by the
  // local→synced migration to preserve a doc's on-device creation
  // time); otherwise we stamp now. `updated_at` is always now —
  // there is no migration use case for backdating it.
  const row = await c.env.DB.prepare(
    `INSERT INTO documents (workspace_id, created_by_user_id, slug, title, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, COALESCE(?, 'Untitled'), ?, ?, ?)
     RETURNING id, slug, title, sort_order, created_at, updated_at`,
  )
    .bind(
      workspace.id,
      userId,
      slug,
      body.title ?? null,
      body.sort_order,
      body.created_at ?? now,
      now,
    )
    .first<DocumentRow>();

  if (!row) {
    return c.json({ error: "Failed to create document" }, 500);
  }

  return c.json(serializeDocumentRow(row), 201);
});

// Get a single document's metadata (snapshot is null; the live state
// lives in the Durable Object).
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
    `SELECT d.id, d.slug, d.title, d.sort_order, d.created_at, d.updated_at
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
  )
    .bind(id, userId)
    .first<DocumentRow>();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ meta: serializeDocumentRow(row), snapshot: null });
});

// Update document metadata. The doc must already exist — there is no
// upsert path; document creation goes through POST /api/documents.
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

  const bodyResult = v.safeParse(documentUpdateSchema, json);
  if (!bodyResult.success) {
    return c.json(
      { error: "Invalid document metadata", details: bodyResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
  const body = bodyResult.output;

  // `updated_at` is intentionally not in the SET clause: the schema's
  // updated_at trigger refreshes it automatically when the UPDATE
  // doesn't already set it (`WHEN NEW.updated_at IS OLD.updated_at`).
  const row = await c.env.DB.prepare(
    `UPDATE documents
     SET title = ?, sort_order = ?
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
       AND deleting_at IS NULL
     RETURNING id, slug, title, sort_order, created_at, updated_at`,
  )
    .bind(body.title, body.sort_order, id, userId)
    .first<DocumentRow>();

  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(serializeDocumentRow(row));
});

// Soft-delete a document. The DO takes over R2 sweep + final row
// removal after the grace period (see assets.ts startDocumentDeletion).
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
    `SELECT d.deleting_at
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ?`,
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

  // Cap the body size before reading. Cloudflare's default request
  // limit is generous; this stops a runaway client from streaming
  // arbitrary blobs at the DO snapshot store. Note: bypassable via
  // chunked transfer encoding or an omitted Content-Length header —
  // defense in depth, not a hard cap.
  const declaredLength = Number(c.req.header("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_SNAPSHOT_BODY_BYTES
  ) {
    return c.json({ error: "Snapshot body too large" }, 413);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const bodyResult = v.safeParse(snapshotPushBodySchema, json);
  if (!bodyResult.success) {
    return c.json(
      { error: "Invalid request body", details: bodyResult.issues },
      400,
    );
  }

  const { id } = paramsResult.output;
  const { snapshot, expectedSnapshotVersion } = bodyResult.output;

  const row = await c.env.DB.prepare(
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
  )
    .bind(id, userId)
    .first();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }

  const documentIdStr = String(id);
  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentIdStr);
  await room.claimDocument(documentIdStr);
  const result = await room.replaceSnapshot(snapshot, expectedSnapshotVersion);
  if (!result.replaced) {
    return c.json(
      {
        error: "Conflict",
        snapshotVersion: result.snapshotVersion,
        reason: result.reason,
      },
      409,
    );
  }

  // Bump updated_at in D1. The trigger would refresh it for any UPDATE,
  // but we want to record the snapshot push time deterministically and
  // not race with whatever else might be happening in this transaction.
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE documents
     SET updated_at = ?
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)`,
  )
    .bind(now, id, userId)
    .run();

  return c.json({ ok: true });
});

app.get("/api/documents/:id/offline-cache", async (c) => {
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
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
  )
    .bind(id, userId)
    .first();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }

  const documentIdStr = String(id);
  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentIdStr);
  await room.claimDocument(documentIdStr);
  const cachedSnapshot = await room.getCachedSnapshot();
  return c.json(cachedSnapshot);
});

app.get("/api/documents/:id/snapshot-status", async (c) => {
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
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
  )
    .bind(id, userId)
    .first();
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }

  const documentIdStr = String(id);
  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentIdStr);
  await room.claimDocument(documentIdStr);
  const status = await room.getSnapshotStatus();
  return c.json(status);
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
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
  )
    .bind(documentId, userId)
    .first();

  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  const room = c.env.DOCUMENT_SYNC_ROOM.getByName(String(documentId));

  // Unlike DO RPC calls above, WebSocket upgrades enter through
  // DocumentSyncRoom.fetch(), which claims and validates the document id from
  // the already-validated request path before accepting the socket.
  return room.fetch(c.req.raw);
});

export default app;
