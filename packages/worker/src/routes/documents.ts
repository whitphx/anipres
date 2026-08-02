import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import * as z from "zod";
import { getAnimationDataVersionGateResponse } from "../animation-data-version";
import { documentIdParamSchema } from "../schemas";
import {
  scheduleDocumentDeletion,
  startDocumentDeletion,
} from "../tldraw-assets";
import type { AppBindings, AppContext } from "../types";
import { bumpWorkspaceFeed } from "../WorkspaceFeedRoom";

const nonNegativeFiniteInteger = z.number().int().min(0);

const DOCUMENT_TITLE_MAX_LENGTH = 256;

// Server-side floor for callers that bypass the client's "Untitled"
// fallback: empty / whitespace-only titles would render as a blank
// sidebar row. Null bytes are rejected because D1's TEXT tolerates
// them but they break grep and leak through raw logs.
const documentTitleSchema = z
  .string()
  .min(1)
  .regex(/\S/u, "Title cannot be only whitespace")
  .max(DOCUMENT_TITLE_MAX_LENGTH)
  .regex(/^[^\u0000]*$/u, "Title contains a null byte");

// Sort-order is a fractional-indexing key (printable-ASCII string;
// see https://www.npmjs.com/package/fractional-indexing). The bound
// is a sanity cap to reject pathological inputs.
const SORT_ORDER_MAX_LENGTH = 256;
const sortOrderSchema = z
  .string()
  .min(1, "sort_order cannot be empty")
  .max(SORT_ORDER_MAX_LENGTH, "sort_order too long");

// Workspace ids are INTEGER on the server side (see the migration);
// clients pass them as decimal strings on the wire. Coerce to JS
// number after validation so handlers can pass it straight to D1
// `.bind()`. The `Number.isSafeInteger` refine rejects digit strings
// above 2^53-1: the regex would happily accept them, and `Number(s)`
// would silently round, leaving the validator + transform out of
// sync. Realistically auto-incremented ids never approach the bound,
// but the cheap refine keeps the contract honest.
const workspaceIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "Invalid workspace id")
  .refine((s) => Number.isSafeInteger(Number(s)), "Invalid workspace id")
  .transform(Number);

export const documentListQuerySchema = z.object({
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
export const documentUpsertSchema = z.object({
  workspace_id: workspaceIdSchema,
  title: documentTitleSchema,
  sort_order: sortOrderSchema,
  created_at: nonNegativeFiniteInteger.optional(),
});

// Cap on snapshot push body size. Prevents a runaway client from
// streaming arbitrary blobs at the DO; sized with headroom over
// realistic tldraw snapshot sizes.
const MAX_SNAPSHOT_BODY_BYTES = 5 * 1024 * 1024;
export const snapshotPushBodySchema = z.object({
  snapshot: z.record(z.string(), z.unknown()),
  expectedSnapshotVersion: nonNegativeFiniteInteger,
});

type DocumentRow = {
  id: string;
  slug: string;
  title: string;
  sort_order: string;
  created_at: number;
  updated_at: number;
};

function generateDocumentSlug() {
  return nanoid();
}

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

export const documentsRoutes = new Hono<AppBindings>()
  // "Active" — neither soft-deleted nor still initializing — both
  // states are intermediate steps in multi-step lifecycles (asset GC,
  // create finalization) that the user shouldn't see in the sidebar.
  .get(
    "/api/documents",
    zValidator("query", documentListQuerySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid workspace_id", details: result.error.issues },
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
  // `snapshot` is null in this response — the live state lives in
  // the Durable Object, fetched separately via the WebSocket sync.
  .get(
    "/api/documents/:id",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
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
  .put(
    "/api/documents/:id",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    zValidator("json", documentUpsertSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document metadata", details: result.error.issues },
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

      // The alternative to this SELECT-then-branch is a single SQL
      // upsert (`ON CONFLICT DO UPDATE`), but two queries here make
      // the insert-vs-update distinction visible to the handler
      // (different status codes, different state checks) without
      // piling CASE expressions into the SQL. Two parallel PUTs for
      // the same id race on the INSERT below; the UNIQUE-constraint
      // trip surfaces as 409 so the client can retry.
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
        // Soft-deleting rows and cross-workspace mismatches both
        // collapse to 404 from the client's perspective — there's no
        // "this lives elsewhere" leak, and we don't support
        // cross-workspace moves.
        //
        // `initializing_at` is deliberately *not* a rejection
        // condition. PUT-as-upsert needs to be replayable: the
        // convert-to-synced flow does PUT → upload assets → push
        // snapshot, and any failure between PUT and snapshot push
        // leaves a row stuck initializing. The retry replays the
        // same PUT with the same body; if we rejected initializing
        // rows, the retry would 404 until the sweep cleaned up,
        // which doesn't fit interactive retry. Letting the metadata
        // UPDATE through is harmless — the row stays initializing,
        // the snapshot push remains the sole finalizer, and any
        // orphan tldraw_assets rows from the prior attempt get GC'd
        // by the asset sweep at the next push.
        if (
          existing.deleting_at !== null ||
          existing.workspace_id !== workspaceId
        ) {
          return c.json({ error: "Not found" }, 404);
        }

        // updated_at is left to the documents.updated_at trigger.
        // created_at on the body is ignored: backdating is only
        // meaningful at insert.
        //
        // The WHERE clause re-asserts the rejection conditions the
        // pre-SELECT checked (workspace match, not deleting). The
        // SELECT alone isn't enough — between it and this UPDATE
        // another request could soft-delete the row. With these
        // guards on the UPDATE itself, a state transition in that
        // window safely flips the result to 0 changes → 404 instead
        // of writing title/sort_order onto a row in a state we just
        // rejected. The pre-SELECT still drives the
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
        // Initializing rows aren't visible in /api/documents, so an
        // update on one doesn't change list output for any
        // subscriber yet. Skip the bump until /finalize or the
        // finalizing snapshot push transitions the row into view.
        if (existing.initializing_at === null) {
          bumpWorkspaceFeed(c, workspaceId);
        }
        return c.json(row, 200);
      }

      // The new row will be invisible to list/get/update until the
      // client's finalizing snapshot push (or /finalize call) clears
      // initializing_at. The scheduled sweep cleans up rows that
      // never get finalized.
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
        //   - id    : two PUTs for the same id raced; the realistic
        //             case is a buggy client reusing an id rather
        //             than a genuine UUID v7 collision.
        //   - slug  : slug collision. Surface distinctly so the
        //             operator notices if it ever fires.
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
  // The DO takes over R2 sweep + final row removal after the grace
  // period (see `startDocumentDeletion` in `../tldraw-assets`).
  .delete(
    "/api/documents/:id",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const document = await c.env.DB.prepare(
        `SELECT workspace_id, deleting_at, initializing_at
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)`,
      )
        .bind(id, userId)
        .first<{
          workspace_id: number;
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
      bumpWorkspaceFeed(c, document.workspace_id);
      return c.json({ ok: true as const }, 200);
    },
  )
  // Cancels a document the creating client gave up on before it was
  // finalized — the offline-reconnect fork flow creates the row first
  // and pushes the snapshot second, and a failed push (e.g. the
  // animation-data version gate's 426) would otherwise strand an
  // invisible initializing row until the scheduled sweep reaps it.
  // The regular DELETE route deliberately 404s initializing rows
  // (the user never saw them in a list), so cancellation is its own
  // narrowly-scoped operation: it only ever removes a row that is
  // still initializing AND whose DO never received a snapshot —
  // mirroring the sweep's "genuinely abandoned" test, so it can
  // never destroy pushed content.
  .delete(
    "/api/documents/:id/initialization",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      const document = await c.env.DB.prepare(
        `SELECT initializing_at, deleting_at
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)`,
      )
        .bind(id, userId)
        .first<{
          initializing_at: number | null;
          deleting_at: number | null;
        }>();
      // Missing, foreign-workspace, and mid-deletion rows all collapse
      // to the same 404 — no existence leak, and a repeated
      // cancellation after success lands here (safe: the state it
      // wanted is already reality).
      if (!document || document.deleting_at !== null) {
        return c.json({ error: "Not found" }, 404);
      }
      const room = c.env.DOCUMENT_SYNC_ROOM.getByName(id);
      if (document.initializing_at === null) {
        // Finalized documents must go through the regular deletion
        // lifecycle; this path only exists for rows the user never
        // saw. Clearing any cancellation reservation here self-heals
        // the crash window of an earlier attempt that reserved the
        // room but died before its D1 delete, then lost to /finalize —
        // a live document must never have its pushes blocked.
        await room.clearInitializationCancellation();
        return c.json({ error: "Document is already finalized" }, 409);
      }

      // Refuses if a snapshot already landed (the sweep later
      // reconciles that row by finalizing it); otherwise reserves the
      // room so later pushes fail. See DocumentSyncRoom.
      // cancelInitialization for why this cannot be a read-only probe.
      const { cancelled } = await room.cancelInitialization();
      if (!cancelled) {
        return c.json({ error: "Document already has content" }, 409);
      }

      // The IS NOT NULL guard re-asserts the initializing state
      // atomically. With the room reserved, the only way this row can
      // change state concurrently is /finalize (which never touches the
      // DO) or another cancellation. Not a hard DELETE: the FK cascade
      // would only remove the asset ROWS, while R2 objects from the
      // abandoned attempt need the retryable, DO-driven prefix sweep
      // that the `deleting_at` lifecycle owns — the same one the
      // regular delete route uses (`finalizeDeletingDocument` removes
      // the row once the prefix is empty).
      const result = await c.env.DB.prepare(
        `UPDATE documents
            SET deleting_at = ?
          WHERE id = ?
            AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
            AND initializing_at IS NOT NULL
            AND deleting_at IS NULL`,
      )
        .bind(Date.now(), id, userId)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        // The row changed state between the SELECT and the UPDATE.
        // Distinguish the races so the response stays truthful: a
        // concurrent /finalize made the doc live (409, and the
        // reservation must be lifted so pushes to it work), while a
        // concurrent cancellation already moved the row into deletion
        // — or it is gone entirely — (404, same as a repeat: the state
        // this call wanted is already reality).
        const raced = await c.env.DB.prepare(
          `SELECT deleting_at FROM documents WHERE id = ?`,
        )
          .bind(id)
          .first<{ deleting_at: number | null }>();
        if (raced && raced.deleting_at === null) {
          await room.clearInitializationCancellation();
          return c.json({ error: "Document is already finalized" }, 409);
        }
        return c.json({ error: "Not found" }, 404);
      }
      try {
        await scheduleDocumentDeletion(c.env, id);
      } catch (error) {
        // Scheduling failed: revert to the initializing state so the
        // scheduled sweep retries the same transition later, instead of
        // leaving the row stuck in a deleting state nothing is driving.
        // (The room reservation stays — it blocks pushes either way,
        // and cancelled ids are never legitimately reused.)
        await c.env.DB.prepare(
          `UPDATE documents
              SET deleting_at = NULL
            WHERE id = ? AND deleting_at IS NOT NULL`,
        )
          .bind(id)
          .run();
        throw error;
      }
      // No feed bump: an initializing row was never visible in any
      // list, so its removal changes nothing for subscribers.
      return c.json({ ok: true as const }, 200);
    },
  )
  // Fresh creates have no content yet and the DO room can stay
  // un-seeded until the user actually opens the doc — so this just
  // clears `initializing_at` to make the row visible. Flows that
  // already have a real snapshot finalize via the snapshot push
  // handler below; this endpoint exists for the empty-doc case
  // where pushing a synthesized empty snapshot would be wasted work.
  .post(
    "/api/documents/:id/finalize",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id } = c.req.valid("param");
      // The IS NOT NULL guard makes finalize idempotent — calling it
      // on an already-finalized doc is a no-op rather than an error.
      // The ownership/deleting filters are the same as the regular
      // update path: we don't want a finalize call to revive a
      // soft-deleted doc, and we want a clean 404 for foreign /
      // non-existent ids.
      const finalized = await c.env.DB.prepare(
        `UPDATE documents
            SET initializing_at = NULL
          WHERE id = ?
            AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
            AND deleting_at IS NULL
            AND initializing_at IS NOT NULL
        RETURNING workspace_id`,
      )
        .bind(id, userId)
        .first<{ workspace_id: number }>();

      if (finalized) {
        bumpWorkspaceFeed(c, finalized.workspace_id);
        return c.json({ ok: true as const }, 200);
      }

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

      return c.json({ ok: true as const }, 200);
    },
  )
  // A successful push also clears `initializing_at` if it was set,
  // finalizing the doc — so a creation flow that pushes a real
  // snapshot here doesn't need to also call /finalize.
  .put(
    "/api/documents/:id/snapshot",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c, next) => {
      const versionGateResponse = getAnimationDataVersionGateResponse(
        c.req.raw,
      );
      if (versionGateResponse) return versionGateResponse;
      await next();
    },
    // The schema validator parses the JSON, which means the body is
    // fully buffered before it runs — gating on content-length here
    // keeps a runaway client from streaming multi-MB blobs into the
    // parser. Defense in depth: content-length can be omitted, in
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
    zValidator("json", snapshotPushBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid request body", details: result.error.issues },
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
        `SELECT workspace_id, initializing_at
         FROM documents
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL`,
      )
        .bind(id, userId)
        .first<{ workspace_id: number; initializing_at: number | null }>();
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
        if (result.reason === "initialization-cancelled") {
          // A cancellation won the race after this handler's row check:
          // the initializing row is gone (or about to be). Report the
          // document as missing, not as a retryable conflict.
          return c.json({ error: "Not found" }, 404);
        }
        return c.json(
          {
            error: "Conflict",
            snapshotVersion: result.snapshotVersion,
            reason: result.reason,
          },
          409,
        );
      }

      // The `deleting_at IS NULL` guard mirrors the pre-DO check
      // above and closes the race where a DELETE landed between that
      // check and here; without it the UPDATE would briefly clear
      // initializing_at on a row already on its way out. Repeating
      // the same clear on a non-initializing row is harmless.
      //
      // updated_at: the trigger would refresh it for any UPDATE, but
      // we want to record the snapshot push time deterministically
      // and not race with whatever else might be happening in this
      // transaction.
      const now = Date.now();
      const finalizeResult = await c.env.DB.prepare(
        `UPDATE documents
         SET updated_at = ?, initializing_at = NULL
         WHERE id = ?
           AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
           AND deleting_at IS NULL`,
      )
        .bind(now, id, userId)
        .run();
      if ((finalizeResult.meta.changes ?? 0) === 0) {
        // The row vanished (or entered deletion) between the pre-DO
        // check and here — e.g. the initialization sweep hard-deleted a
        // stale row, or a DELETE landed. The DO write cannot be undone,
        // but success must not be reported for a document that no
        // longer exists.
        return c.json({ error: "Not found" }, 404);
      }

      // Bump only on the initializing → visible transition. Bumping
      // on every snapshot push (which the editor issues every few
      // seconds during active drawing) would flood subscribers with
      // doc-list refetches that wouldn't see any change in the list
      // output beyond updated_at.
      if (row.initializing_at !== null) {
        bumpWorkspaceFeed(c, row.workspace_id);
      }

      return c.json({ ok: true as const }, 200);
    },
  )
  .get(
    "/api/documents/:id/offline-cache",
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
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
    zValidator("param", documentIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid document id", details: result.error.issues },
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
