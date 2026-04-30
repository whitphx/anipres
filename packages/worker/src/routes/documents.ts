import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import * as v from "valibot";
import { documentIdParamSchema } from "../schemas";
import { startDocumentDeletion } from "../tldraw-assets";
import type { AppBindings, AppContext } from "../types";

const nonNegativeFiniteInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
);

const DOCUMENT_TITLE_MAX_LENGTH = 256;

// Server-side floor for callers that bypass the client's "Untitled"
// fallback in createNewDocument: empty / whitespace-only titles would
// render as a blank sidebar row. Null bytes are rejected because D1's
// TEXT tolerates them but they break grep and leak through raw logs.
const documentTitleSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.regex(/\S/u, "Title cannot be only whitespace"),
  v.maxLength(DOCUMENT_TITLE_MAX_LENGTH),
  v.regex(/^[^\u0000]*$/u, "Title contains a null byte"),
);

// Sort-order is a fractional-indexing key (printable-ASCII string;
// see https://www.npmjs.com/package/fractional-indexing). The bound
// is a sanity cap to reject pathological inputs.
const SORT_ORDER_MAX_LENGTH = 256;
const sortOrderSchema = v.pipe(
  v.string(),
  v.minLength(1, "sort_order cannot be empty"),
  v.maxLength(SORT_ORDER_MAX_LENGTH, "sort_order too long"),
);

// Workspace ids are server-allocated INTEGER autoincrement values
// passed as decimal strings on the wire. Coerce to JS number after
// validation so handlers can pass it straight to D1 `.bind()`. The
// asymmetry with `documents.id` (which stays TEXT end-to-end) is
// deliberate: workspaces are a server-side concept the user never
// originates offline, so the INTEGER rowid wins (smaller indexes,
// sequential inserts); documents need their id to flow unchanged
// through the local → synced path.
const workspaceIdSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/u, "Invalid workspace id"),
  v.transform(Number),
);

export const documentListQuerySchema = v.object({
  workspace_id: workspaceIdSchema,
});

// Single upsert wire shape — covers both insert and update. The
// client sends the post-state, so `title` and `sort_order` are
// required even on re-save (replaying the same body is a no-op).
// `workspace_id` on update has to match the existing row
// (cross-workspace moves return 404). `created_at` is an
// insert-only override used by the local→synced migration to
// preserve on-device creation time; ignored on update. `updated_at`
// is always server-stamped via the documents.updated_at trigger;
// `id` lives in the URL path (see `documentIdParamSchema`).
export const documentUpsertSchema = v.object({
  workspace_id: workspaceIdSchema,
  title: documentTitleSchema,
  sort_order: sortOrderSchema,
  created_at: v.optional(nonNegativeFiniteInteger),
});

// Cap on snapshot push body size. Prevents a runaway client from
// streaming arbitrary blobs at the DO; sized with headroom over
// realistic tldraw snapshot sizes (typically well under 1 MB even
// for docs with embedded references).
const MAX_SNAPSHOT_BODY_BYTES = 5 * 1024 * 1024;
export const snapshotPushBodySchema = v.object({
  snapshot: v.record(v.string(), v.unknown()),
  expectedSnapshotVersion: nonNegativeFiniteInteger,
});

// Wire shape of a documents-table row as returned by every JSON
// endpoint in this file. Ids are TEXT (UUID v7 strings,
// client-allocated) and timestamps are integer ms — no per-field
// massaging needed at the JSON boundary.
type DocumentRow = {
  id: string;
  slug: string;
  title: string;
  sort_order: string;
  created_at: number;
  updated_at: number;
};

// Slug generator. Phase 1 doesn't surface slugs in the UI; the column
// is populated for forward compatibility. `crypto.randomUUID()` is
// overkill for collision avoidance but keeps it one line and avoids
// pulling in nanoid. Swap to a shorter format when slugs become
// user-visible.
function generateDocumentSlug() {
  return crypto.randomUUID();
}

// Returns true iff the workspace exists and is owned by `userId`.
// Phase 1 has 1:1 user:workspace, so this is a presence check;
// Extension A will replace this with a membership query against
// `workspaces` ∪ `org_memberships`.
async function userOwnsWorkspace(
  c: AppContext,
  userId: number,
  workspaceId: number,
): Promise<boolean> {
  const row = await c.env.DB.prepare(
    "SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?",
  )
    .bind(workspaceId, userId)
    .first();
  return Boolean(row);
}

// All JSON endpoints under `/api/documents/*` (excluding the asset
// sub-resource, which has its own multipart-aware sub-router in
// `./document-assets.ts`).
export const documentsRoutes = new Hono<AppBindings>()
  // List active documents in a workspace, in sort order.
  //
  // "Active" means neither soft-deleted nor still initializing. Rows
  // in either of those states are an implementation detail of a
  // multi-step lifecycle the user shouldn't see: deleting rows are
  // mid-asset-GC, initializing rows are mid-create. The partial index
  // `idx_documents_workspace_sort` matches this exact predicate.
  //
  // Why a query param instead of a path segment: `/api/documents/:id`
  // is already the per-doc route; making the list-route
  // `/api/documents` keeps the surface flat and pairs naturally with
  // the per-doc routes. Extension A will likely add
  // `/api/workspaces/:wsid/documents` as a secondary form for
  // org-scoped enumeration.
  .get(
    "/api/documents",
    vValidator("query", documentListQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid workspace_id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { workspace_id: workspaceId } = c.req.valid("query");

      if (!(await userOwnsWorkspace(c, userId, workspaceId))) {
        // 404 rather than 403: don't reveal whether the workspace
        // exists for some other user. Indistinguishable from
        // "workspace doesn't exist at all" from the client's
        // perspective.
        return c.json({ error: "Not found" }, 404);
      }

      const { results } = await c.env.DB.prepare(
        `SELECT id, slug, title, sort_order, created_at, updated_at
         FROM documents
         WHERE workspace_id = ?
           AND deleting_at IS NULL
           AND initializing_at IS NULL
         ORDER BY sort_order ASC`,
      )
        .bind(workspaceId)
        .all<DocumentRow>();
      return c.json(results, 200);
    },
  )
  // Get a single document's metadata (snapshot is null; the live
  // state lives in the Durable Object).
  .get(
    "/api/documents/:id",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      // Ownership scoping is expressed by filtering on the doc's
      // `workspace_id` against the set of workspaces owned by the user.
      // The IN-subquery form is consistent with the other per-doc
      // handlers and reads as "this doc, in one of my workspaces."
      const row = await c.env.DB.prepare(
        `SELECT id, slug, title, sort_order, created_at, updated_at
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL
           AND initializing_at IS NULL`,
      )
        .bind(id, userId)
        .first<DocumentRow>();
      if (!row) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ meta: row, snapshot: null }, 200);
    },
  )
  // Upsert a document by id. PUT-as-upsert is the canonical pattern
  // for client-allocated ids: the client supplies the doc id (UUID
  // v7) and the body describes the post-state. The handler branches
  // on row existence: insert with initializing_at on first call,
  // update title/sort_order on subsequent calls. workspace_id is
  // always in the body — on insert it places the row, on update it
  // has to match the existing row (cross-workspace moves return 404).
  .put(
    "/api/documents/:id",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    vValidator("json", documentUpsertSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document metadata", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = body.workspace_id;

      if (!(await userOwnsWorkspace(c, userId, workspaceId))) {
        return c.json({ error: "Not found" }, 404);
      }

      // Branch on existence with a SELECT first. The alternative is a
      // single SQL upsert (`ON CONFLICT DO UPDATE`), but two queries
      // here make the insert-vs-update distinction visible to the
      // handler (different status codes, different state checks)
      // without piling CASE expressions into the SQL. Two parallel
      // PUTs for the same id race on the INSERT below; the
      // UNIQUE-constraint trip surfaces as 409 so the client can
      // retry.
      const existing = await c.env.DB.prepare(
        `SELECT workspace_id, deleting_at, initializing_at
         FROM documents
         WHERE id = ?`,
      )
        .bind(id)
        .first<{
          workspace_id: number;
          deleting_at: number | null;
          initializing_at: number | null;
        }>();

      if (existing) {
        // Update path. Reject any state that means "this row isn't a
        // user-visible doc the caller can address right now":
        //   - soft-deleting: row is on its way out.
        //   - workspace_id mismatch: doc lives in another workspace
        //     (we don't allow cross-workspace moves).
        // Both collapse to 404 from the client's perspective.
        //
        // `initializing_at` is deliberately *not* a rejection
        // condition. PUT-as-upsert needs to be replayable: the
        // convert-to-synced flow does PUT → upload assets → push
        // snapshot, and any failure between PUT and snapshot push
        // leaves a row stuck initializing. The retry replays the
        // same PUT with the same body; if we rejected initializing
        // rows, the retry would 404 forever (the sweep eventually
        // cleans up after a 10-minute grace window, but interactive
        // retry is a minute-zero need). Letting the metadata UPDATE
        // through is harmless — the row stays initializing, the
        // snapshot push remains the sole finalizer (the `PUT
        // /api/documents/:id/snapshot` handler clears
        // `initializing_at` on a successful push), and any orphan
        // tldraw_assets rows from the prior attempt get GC'd by the
        // asset sweep at the next push.
        if (
          existing.deleting_at !== null ||
          existing.workspace_id !== workspaceId
        ) {
          return c.json({ error: "Not found" }, 404);
        }

        // updated_at is left to the trigger — see the documents
        // updated_at trigger in 0001_initial_schema.sql. created_at
        // on the body is ignored: backdating is only meaningful at
        // insert.
        //
        // The WHERE clause re-asserts the rejection conditions the
        // pre-SELECT checked (workspace match, not deleting). The
        // SELECT alone isn't enough — between it and this UPDATE
        // another request could soft-delete the row or (in some
        // future Extension B world) move it across workspaces. With
        // these guards on the UPDATE itself, a state transition in
        // that window safely flips the result to 0 changes → 404
        // instead of writing title/sort_order onto a row in a state
        // we just rejected. The pre-SELECT still drives the
        // insert-vs-update branch decision; it just no longer
        // carries the safety contract.
        const row = await c.env.DB.prepare(
          `UPDATE documents
           SET title = ?, sort_order = ?
           WHERE id = ?
             AND workspace_id = ?
             AND deleting_at IS NULL
           RETURNING id, slug, title, sort_order, created_at, updated_at`,
        )
          .bind(body.title, body.sort_order, id, workspaceId)
          .first<DocumentRow>();
        if (!row) {
          // The row's state changed between the SELECT and the
          // UPDATE (delete, etc.). 404 is the right code — from the
          // client's point of view the doc is no longer updatable in
          // the workspace it asked for.
          return c.json({ error: "Not found" }, 404);
        }
        return c.json(row, 200);
      }

      // Insert path. The row will be invisible to list/get/update
      // until the client's finalizing snapshot push (or /finalize
      // call) clears initializing_at. The scheduled sweep cleans up
      // rows that never get finalized.
      const slug = generateDocumentSlug();
      const now = Date.now();

      let row: DocumentRow | null;
      try {
        row = await c.env.DB.prepare(
          `INSERT INTO documents (id, workspace_id, created_by_user_id, slug, title, sort_order, created_at, updated_at, initializing_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id, slug, title, sort_order, created_at, updated_at`,
        )
          .bind(
            id,
            workspaceId,
            userId,
            slug,
            body.title,
            body.sort_order,
            body.created_at ?? now,
            now,
            now,
          )
          .first<DocumentRow>();
      } catch (error) {
        // SQLite reports UNIQUE-constraint trips as
        // "UNIQUE constraint failed: <table>.<column>", so
        // distinguish by the column name. Two unique columns on
        // documents:
        //   - id    : two PUTs for the same id raced (UUID v7
        //             collision is astronomically unlikely; the
        //             realistic case is a buggy client reusing an
        //             id).
        //   - slug  : crypto.randomUUID() collision — even more
        //             unlikely (one in 2^61 odds with a million
        //             docs). Surface distinctly so the operator
        //             notices if it ever fires.
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: documents\.id/i.test(message)) {
          return c.json({ error: "Document id already exists" }, 409);
        }
        if (/UNIQUE constraint failed: documents\.slug/i.test(message)) {
          console.error("Slug collision on document insert:", message);
          return c.json({ error: "Slug collision; retry the request" }, 409);
        }
        throw error;
      }

      if (!row) {
        return c.json({ error: "Failed to create document" }, 500);
      }
      return c.json(row, 201);
    },
  )
  // Soft-delete a document. The DO takes over R2 sweep + final row
  // removal after the grace period (see tldraw-assets.ts
  // startDocumentDeletion).
  .delete(
    "/api/documents/:id",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const document = await c.env.DB.prepare(
        `SELECT deleting_at, initializing_at
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)`,
      )
        .bind(id, userId)
        .first<{
          deleting_at: number | null;
          initializing_at: number | null;
        }>();
      if (!document) {
        return c.json({ error: "Not found" }, 404);
      }

      // Initializing rows are invisible to the client and cleaned up
      // by the scheduled sweep. Treat a delete request against one as
      // a 404 — the user couldn't have seen it in any list.
      if (
        document.initializing_at !== null &&
        document.initializing_at !== undefined
      ) {
        return c.json({ error: "Not found" }, 404);
      }

      if (
        document.deleting_at !== null &&
        document.deleting_at !== undefined
      ) {
        return c.json({ ok: true as const }, 200);
      }

      await startDocumentDeletion(c, userId, id);
      return c.json({ ok: true as const }, 200);
    },
  )
  // Finalize a fresh synced document without pushing a snapshot.
  // Fresh creates have no content yet and the DO room can stay
  // un-seeded until the user actually opens the doc — so this just
  // clears `initializing_at` to make the row visible. Migration and
  // reconnect-fork flows have a real snapshot to push and finalize
  // via the snapshot push handler below; this endpoint is for the
  // empty-doc case where a snapshot push would just need to be
  // synthesized.
  .post(
    "/api/documents/:id/finalize",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      // The IS NOT NULL guard makes finalize idempotent — calling it on
    // an already-finalized doc is a no-op rather than an error. The
      // ownership/deleting filters are the same as the regular update
      // path: we don't want a finalize call to revive a soft-deleted
      // doc, and we want a clean 404 for foreign / non-existent ids.
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
           FROM documents
           WHERE id = ?
             AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
             AND deleting_at IS NULL`,
        )
          .bind(id, userId)
          .first();
        if (!exists) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      return c.json({ ok: true as const }, 200);
    },
  )
  // Push a snapshot into the Durable Object room. Used by the
  // local→synced migration to land a converted doc's content, and by
  // the push-or-fork reconnect flow to land a returning client's
  // offline edits. A successful push also clears `initializing_at` if
  // it was set, finalizing the doc — so a doc whose creation flow
  // pushes a real snapshot doesn't need to also call /finalize.
  .put(
    "/api/documents/:id/snapshot",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    // Body-size cap as a separate middleware before the schema
    // validator. The validator parses the JSON, which means the body
    // is fully buffered before this point — gating on content-length
    // here keeps a runaway client from streaming multi-MB blobs into
    // the parser. Defense in depth: content-length can be omitted, in
    // which case the schema validator's own size limits and the
    // platform-level body limit are the next gates.
    async (c, next) => {
      const declaredLength = Number(c.req.header("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_SNAPSHOT_BODY_BYTES
      ) {
        return c.json({ error: "Snapshot body too large" }, 413);
      }
      await next();
    },
    vValidator("json", snapshotPushBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid request body", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const { snapshot, expectedSnapshotVersion } = c.req.valid("json");

      // Snapshot push reaches both regular and still-initializing
      // rows. Initializing rows are the *expected* target right after
      // POST: the client has just created the doc and is now
      // finalizing it. Only soft-deleting rows are off-limits (their
      // DO state is being torn down).
      const row = await c.env.DB.prepare(
        `SELECT 1
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL`,
      )
        .bind(id, userId)
        .first();
      if (!row) {
        return c.json({ error: "Not found" }, 404);
      }

      const room = c.env.DOCUMENT_SYNC_ROOM.getByName(id);
      await room.claimDocument(id);
      const result = await room.replaceSnapshot(
        snapshot,
        expectedSnapshotVersion,
      );
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

      // Finalize the document: bump updated_at and clear
      // initializing_at (whether or not it was set). Repeating this
      // UPDATE is harmless — the second UPDATE rewrites the same
      // value to the column. The `deleting_at IS NULL` guard mirrors
      // the pre-DO check above and closes the race where a DELETE
      // landed between that check and here; without it the UPDATE
      // would briefly clear initializing_at on a row already on its
      // way out.
      //
      // updated_at: the trigger would refresh it for any UPDATE, but
      // we want to record the snapshot push time deterministically
      // and not race with whatever else might be happening in this
      // transaction.
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

      return c.json({ ok: true as const }, 200);
    },
  )
  .get(
    "/api/documents/:id/offline-cache",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      // The offline cache only makes sense for fully-finalized docs. An
      // initializing row has no DO state worth fetching — the cache
      // fetch is part of the reconnect flow which only runs against
      // docs the client already saw in a list.
      const row = await c.env.DB.prepare(
        `SELECT 1
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL
           AND initializing_at IS NULL`,
      )
        .bind(id, userId)
        .first();
      if (!row) {
        return c.json({ error: "Not found" }, 404);
      }

      const room = c.env.DOCUMENT_SYNC_ROOM.getByName(id);
      await room.claimDocument(id);
      const cachedSnapshot = await room.getCachedSnapshot();
      return c.json(cachedSnapshot, 200);
    },
  )
  .get(
    "/api/documents/:id/snapshot-status",
    vValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const row = await c.env.DB.prepare(
        `SELECT 1
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL
           AND initializing_at IS NULL`,
      )
        .bind(id, userId)
        .first();
      if (!row) {
        return c.json({ error: "Not found" }, 404);
      }

      const room = c.env.DOCUMENT_SYNC_ROOM.getByName(id);
      await room.claimDocument(id);
      const status = await room.getSnapshotStatus();
      return c.json(status, 200);
    },
  );

export type DocumentsRoutes = typeof documentsRoutes;
