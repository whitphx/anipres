import { Hono } from "hono";
import * as v from "valibot";
import { registerAssetRoutes, startDocumentDeletion } from "./assets";
import { registerApiAuth, registerAuthRoutes } from "./auth";
import { sweepInitializingDocuments } from "./cleanup";
import {
  documentConnectParamSchema,
  documentCreateSchema,
  documentIdParamSchema,
  documentUpdateSchema,
  MAX_SNAPSHOT_BODY_BYTES,
  snapshotPushBodySchema,
} from "./schemas";
import type { AppBindings, Env } from "./types";

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
//
// "Active" means neither soft-deleted nor still initializing. Rows in
// either of those states are an implementation detail of a multi-step
// lifecycle the user shouldn't see: deleting rows are mid-asset-GC,
// initializing rows are mid-create. The partial index
// `idx_documents_workspace_sort` matches this exact predicate.
app.get("/api/documents", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.slug, d.title, d.sort_order, d.created_at, d.updated_at
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE w.owner_user_id = ?
       AND d.deleting_at IS NULL
       AND d.initializing_at IS NULL
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
  //
  // `initializing_at` is stamped to mark the row as "not yet finalized"
  // until the client completes the multi-step create flow (asset uploads
  // and the initial snapshot push). The snapshot push handler clears it
  // on success; the scheduled sweep cleans up rows that never get
  // there. Until cleared, this row is invisible to list/get/update/delete.
  const row = await c.env.DB.prepare(
    `INSERT INTO documents (workspace_id, created_by_user_id, slug, title, sort_order, created_at, updated_at, initializing_at)
     VALUES (?, ?, ?, COALESCE(?, 'Untitled'), ?, ?, ?, ?)
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
     WHERE d.id = ?
       AND w.owner_user_id = ?
       AND d.deleting_at IS NULL
       AND d.initializing_at IS NULL`,
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
  // Initializing rows are off-limits to metadata updates — the doc
  // isn't fully realized until the snapshot push completes.
  const row = await c.env.DB.prepare(
    `UPDATE documents
     SET title = ?, sort_order = ?
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
       AND deleting_at IS NULL
       AND initializing_at IS NULL
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
    `SELECT d.deleting_at, d.initializing_at
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ? AND w.owner_user_id = ?`,
  )
    .bind(id, userId)
    .first<{ deleting_at: number | null; initializing_at: number | null }>();
  if (!document) {
    return c.json({ error: "Not found" }, 404);
  }

  // Initializing rows are invisible to the client and cleaned up by
  // the scheduled sweep. Treat a delete request against one as a 404
  // — the user couldn't have seen it in any list.
  if (document.initializing_at !== null && document.initializing_at !== undefined) {
    return c.json({ error: "Not found" }, 404);
  }

  if (document.deleting_at !== null && document.deleting_at !== undefined) {
    return c.json({ ok: true });
  }

  await startDocumentDeletion(c, userId, id);
  return c.json({ ok: true });
});

// Finalize a fresh synced document without pushing a snapshot. Fresh
// creates have no content yet and the DO room can stay un-seeded
// until the user actually opens the doc — so this just clears
// `initializing_at` to make the row visible. Migration and
// reconnect-fork flows have a real snapshot to push and finalize via
// the snapshot push handler below; this endpoint is for the empty-doc
// case where a snapshot push would just need to be synthesized.
app.post("/api/documents/:id/finalize", async (c) => {
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
  // The IS NOT NULL guard makes finalize idempotent — calling it on
  // an already-finalized doc is a no-op rather than an error. The
  // ownership/deleting filters are the same as the regular update path:
  // we don't want a finalize call to revive a soft-deleted doc, and
  // we want a clean 404 for foreign / non-existent ids.
  const result = await c.env.DB.prepare(
    `UPDATE documents
        SET initializing_at = NULL
      WHERE id = ?
        AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
        AND deleting_at IS NULL
        AND initializing_at IS NOT NULL`,
  )
    .bind(id, userId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    // Either the doc doesn't exist for this user, or it's already
    // finalized. Both cases respond with 200 — the caller's intent
    // ("make sure this doc is finalized") is satisfied either way.
    // Distinguish the not-found case so the client can surface a
    // genuine error if the row really doesn't exist.
    const exists = await c.env.DB.prepare(
      `SELECT 1
       FROM documents d
       JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.id = ? AND w.owner_user_id = ? AND d.deleting_at IS NULL`,
    )
      .bind(id, userId)
      .first();
    if (!exists) {
      return c.json({ error: "Not found" }, 404);
    }
  }

  return c.json({ ok: true });
});

// Push a snapshot into the Durable Object room. Used by the
// local→synced migration to land a converted doc's content, and by
// the push-or-fork reconnect flow to land a returning client's
// offline edits. A successful push also clears `initializing_at` if
// it was set, finalizing the doc — so a doc whose creation flow
// pushes a real snapshot doesn't need to also call /finalize.
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

  // Snapshot push reaches both regular and still-initializing rows.
  // Initializing rows are the *expected* target right after POST: the
  // client has just created the doc and is now finalizing it. Only
  // soft-deleting rows are off-limits (their DO state is being torn
  // down).
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

  // Finalize the document: bump updated_at and clear initializing_at
  // (whether or not it was set). Repeating this UPDATE is harmless —
  // the second UPDATE rewrites the same value to the column. The
  // `deleting_at IS NULL` guard mirrors the pre-DO check above and
  // closes the race where a DELETE landed between that check and
  // here; without it the UPDATE would briefly clear initializing_at
  // on a row already on its way out.
  //
  // updated_at: the trigger would refresh it for any UPDATE, but we
  // want to record the snapshot push time deterministically and not
  // race with whatever else might be happening in this transaction.
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE documents
     SET updated_at = ?, initializing_at = NULL
     WHERE id = ?
       AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
       AND deleting_at IS NULL`,
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
  // The offline cache only makes sense for fully-finalized docs. An
  // initializing row has no DO state worth fetching — the cache fetch
  // is part of the reconnect flow which only runs against docs the
  // client already saw in a list.
  const row = await c.env.DB.prepare(
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ?
       AND w.owner_user_id = ?
       AND d.deleting_at IS NULL
       AND d.initializing_at IS NULL`,
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
     WHERE d.id = ?
       AND w.owner_user_id = ?
       AND d.deleting_at IS NULL
       AND d.initializing_at IS NULL`,
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

  // Sync sessions only open against finalized documents. An
  // initializing row's DO room hasn't been seeded with a snapshot yet,
  // so opening a sync session would have nothing to replicate against
  // and would race with the create flow's own snapshot push.
  const document = await c.env.DB.prepare(
    `SELECT 1
     FROM documents d
     JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.id = ?
       AND w.owner_user_id = ?
       AND d.deleting_at IS NULL
       AND d.initializing_at IS NULL`,
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

// Worker entry. Uses the explicit handler shape (rather than
// `export default app`) so a `scheduled` handler can run alongside
// the HTTP fetch handler. The cron trigger is configured in
// wrangler.toml; the handler runs the initializing-doc sweep.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          const { reconciledCount, deletedCount } =
            await sweepInitializingDocuments(env);
          if (reconciledCount > 0 || deletedCount > 0) {
            console.log(
              `[scheduled] Initializing-doc sweep: reconciled ${reconciledCount}, deleted ${deletedCount}.`,
            );
          }
        } catch (error) {
          console.error("[scheduled] Sweep failed:", error);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
