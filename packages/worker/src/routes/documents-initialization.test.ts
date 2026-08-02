import {
  createExecutionContext,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { MINIMUM_SYNC_ANIMATION_DATA_VERSION } from "../animation-data-version";
import type { AppBindings } from "../types";
import { documentsRoutes } from "./documents";
import { getDocumentAssetKey } from "../tldraw-assets";

// Route-level tests for DELETE /api/documents/:id/initialization
// against a real (miniflare) D1 with the production schema applied by
// the test setup file.

// Fresh ids per test: the isolated-storage rollback between tests does
// NOT reset a live DO's in-memory fields, so reusing one document id
// (= one DO instance) would leak snapshotVersion / reservation state
// across tests. Same reason DocumentSyncRoom.test.ts uses a distinct
// room name per test.
let OWNER_DOC: string;
let FINALIZED_DOC: string;
let FOREIGN_DOC: string;
let MISSING_DOC: string;

// The auth middleware lives on the app root, not on documentsRoutes;
// the harness supplies the resolved userId the same way it would.
function appAsUser(userId: number) {
  return new Hono<AppBindings>()
    .use("*", async (c, next) => {
      c.set("userId", userId);
      await next();
    })
    .route("/", documentsRoutes);
}

function cancelInitialization(app: ReturnType<typeof appAsUser>, id: string) {
  return app.request(
    `/api/documents/${id}/initialization`,
    { method: "DELETE" },
    env,
  );
}

function pushSnapshotViaRoute(
  app: ReturnType<typeof appAsUser>,
  id: string,
  body: { snapshot: Record<string, unknown>; expectedSnapshotVersion: number },
) {
  return app.request(
    `/api/documents/${id}/snapshot`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-anipres-animation-data-version": String(
          MINIMUM_SYNC_ANIMATION_DATA_VERSION,
        ),
      },
      body: JSON.stringify(body),
    },
    env,
    // The push route's feed bump uses executionCtx.waitUntil.
    createExecutionContext(),
  );
}

/** A minimal RoomSnapshot that TLSocketRoom.loadSnapshot accepts. */
const EMPTY_ROOM_SNAPSHOT = { clock: 0, documents: [] };

async function documentExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM documents WHERE id = ?`)
    .bind(id)
    .first();
  return row !== null;
}

let ownerUserId: number;
let foreignUserId: number;

beforeEach(async () => {
  OWNER_DOC = crypto.randomUUID();
  FINALIZED_DOC = crypto.randomUUID();
  FOREIGN_DOC = crypto.randomUUID();
  MISSING_DOC = crypto.randomUUID();
  await env.DB.prepare(`DELETE FROM documents`).run();
  await env.DB.prepare(`DELETE FROM workspaces`).run();
  await env.DB.prepare(`DELETE FROM users`).run();

  const owner = await env.DB.prepare(
    `INSERT INTO users DEFAULT VALUES RETURNING id`,
  ).first<{ id: number }>();
  const foreign = await env.DB.prepare(
    `INSERT INTO users DEFAULT VALUES RETURNING id`,
  ).first<{ id: number }>();
  ownerUserId = owner!.id;
  foreignUserId = foreign!.id;

  const ownerWorkspace = await env.DB.prepare(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ('Owner WS', ?) RETURNING id`,
  )
    .bind(ownerUserId)
    .first<{ id: number }>();
  const foreignWorkspace = await env.DB.prepare(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ('Foreign WS', ?) RETURNING id`,
  )
    .bind(foreignUserId)
    .first<{ id: number }>();

  const now = Date.now();
  const insertDoc = (
    id: string,
    workspaceId: number,
    initializingAt: number | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO documents (id, workspace_id, slug, title, sort_order, created_at, updated_at, initializing_at)
       VALUES (?, ?, ?, 'Doc', 'a0', ?, ?, ?)`,
    )
      .bind(id, workspaceId, `slug-${id.slice(-4)}`, now, now, initializingAt)
      .run();

  await insertDoc(OWNER_DOC, ownerWorkspace!.id, now);
  await insertDoc(FINALIZED_DOC, ownerWorkspace!.id, null);
  await insertDoc(FOREIGN_DOC, foreignWorkspace!.id, now);
});

describe("DELETE /api/documents/:id/initialization", () => {
  it("lets the owner cancel an initializing document and removes the row", async () => {
    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, OWNER_DOC);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await documentExists(OWNER_DOC)).toBe(false);
  });

  it("is safe to repeat: a second cancellation reports 404, nothing else changes", async () => {
    const app = appAsUser(ownerUserId);
    expect((await cancelInitialization(app, OWNER_DOC)).status).toBe(200);
    const repeat = await cancelInitialization(app, OWNER_DOC);
    expect(repeat.status).toBe(404);
    // The other rows are untouched.
    expect(await documentExists(FINALIZED_DOC)).toBe(true);
    expect(await documentExists(FOREIGN_DOC)).toBe(true);
  });

  it("refuses to cancel a finalized document and leaves it intact", async () => {
    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, FINALIZED_DOC);
    expect(res.status).toBe(409);
    expect(await documentExists(FINALIZED_DOC)).toBe(true);
  });

  it("answers a foreign-workspace document exactly like a missing one", async () => {
    const app = appAsUser(ownerUserId);
    const foreignRes = await cancelInitialization(app, FOREIGN_DOC);
    const missingRes = await cancelInitialization(app, MISSING_DOC);
    expect(foreignRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(await foreignRes.json()).toEqual(await missingRes.json());
    expect(await documentExists(FOREIGN_DOC)).toBe(true);
  });

  it("refuses to cancel when the DO already holds a snapshot (pushed content survives)", async () => {
    // Simulate the partial-push case: the DO write landed but the
    // finalizing D1 update never did — peekSnapshotVersion then
    // reports > 0 for a row that is still initializing in D1. Both the
    // in-memory field and its backing storage row are set so the state
    // survives a DO eviction between this poke and the route's RPC.
    const room = env.DOCUMENT_SYNC_ROOM.getByName(OWNER_DOC);
    await runInDurableObject(room, async (instance) => {
      const internals = instance as unknown as {
        snapshotVersion: number;
        ctx: {
          storage: {
            sql: { exec: (query: string, ...bindings: unknown[]) => unknown };
          };
        };
      };
      internals.snapshotVersion = 3;
      internals.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO snapshot (id, data, version) VALUES (1, ?, ?)",
        JSON.stringify({ clock: 0, documents: [] }),
        3,
      );
    });

    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, OWNER_DOC);
    expect(res.status).toBe(409);
    expect(await documentExists(OWNER_DOC)).toBe(true);
    // The refusal must not leave a reservation behind — future pushes
    // to this (real, content-bearing) room stay possible.
    await runInDurableObject(room, async (instance) => {
      expect(
        (instance as unknown as { initializationCancelled: boolean })
          .initializationCancelled,
      ).toBe(false);
    });
  });

  // The cancellation-vs-snapshot race is decided inside the DO on the
  // same serialized task queue as replaceSnapshot, so each interleaving
  // is reproduced deterministically by ordering the serialized steps —
  // there is no in-between state left to pause in.

  it("cancellation wins: a push that passed its row check is rejected and no snapshot is retained", async () => {
    // The push route's failing interleaving: its D1 row check passed
    // (row was initializing), then cancellation completed fully, then
    // its replaceSnapshot call runs. The persisted reservation must
    // reject the push instead of writing into the orphaned room.
    const room = env.DOCUMENT_SYNC_ROOM.getByName(OWNER_DOC);
    await room.claimDocument(OWNER_DOC);

    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, OWNER_DOC);
    expect(res.status).toBe(200);
    expect(await documentExists(OWNER_DOC)).toBe(false);

    const push = await room.replaceSnapshot({}, 0);
    expect(push.replaced).toBe(false);
    expect(push.reason).toBe("initialization-cancelled");
    expect(await room.peekSnapshotVersion()).toBe(0);
    // The reservation is persisted, not just in-memory — it must
    // survive a DO eviction to keep rejecting late pushes.
    await runInDurableObject(room, async (instance) => {
      const internals = instance as unknown as {
        ctx: { storage: { get(key: string): Promise<unknown> } };
      };
      expect(await internals.ctx.storage.get("initializationCancelled")).toBe(
        true,
      );
    });
  });

  it("finalize wins the D1 race: cancellation answers 409 and lifts the reservation", async () => {
    // A cancellation attempt reserved the room but its D1 delete lost
    // to /finalize (or the attempt crashed in between): the document is
    // live after all, so the next cancellation call must both refuse
    // (409) and lift the reservation so pushes to the live doc work.
    const room = env.DOCUMENT_SYNC_ROOM.getByName(OWNER_DOC);
    await room.claimDocument(OWNER_DOC);
    expect((await room.cancelInitialization()).cancelled).toBe(true);
    await env.DB.prepare(
      `UPDATE documents SET initializing_at = NULL WHERE id = ?`,
    )
      .bind(OWNER_DOC)
      .run();

    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, OWNER_DOC);
    expect(res.status).toBe(409);
    expect(await documentExists(OWNER_DOC)).toBe(true);
    await runInDurableObject(room, async (instance) => {
      expect(
        (instance as unknown as { initializationCancelled: boolean })
          .initializationCancelled,
      ).toBe(false);
    });
    // A push to the now-live document is no longer blocked by the
    // reservation (it proceeds to the ordinary version check).
    const push = await room.replaceSnapshot({}, 99);
    expect(push.reason).not.toBe("initialization-cancelled");
  });

  it("push ROUTE: a push racing a completed reservation answers 404 with no snapshot retained", async () => {
    // The exact reviewed interleaving, driven through the real route:
    // the D1 row is still initializing (so the route's row check
    // passes), but the room already carries the cancellation
    // reservation — the push must answer 404, not write a snapshot.
    const room = env.DOCUMENT_SYNC_ROOM.getByName(OWNER_DOC);
    await room.claimDocument(OWNER_DOC);
    expect((await room.cancelInitialization()).cancelled).toBe(true);

    const app = appAsUser(ownerUserId);
    const res = await pushSnapshotViaRoute(app, OWNER_DOC, {
      snapshot: EMPTY_ROOM_SNAPSHOT,
      expectedSnapshotVersion: 0,
    });
    expect(res.status).toBe(404);
    expect(await room.peekSnapshotVersion()).toBe(0);
  });

  it("push ROUTE: an ordinary push succeeds and finalizes the row", async () => {
    // Happy-path pin for the finalizing-UPDATE affected-rows check: a
    // mis-read of the result must not turn every successful push into
    // a 404.
    const app = appAsUser(ownerUserId);
    const res = await pushSnapshotViaRoute(app, OWNER_DOC, {
      snapshot: EMPTY_ROOM_SNAPSHOT,
      expectedSnapshotVersion: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await env.DB.prepare(
      `SELECT initializing_at FROM documents WHERE id = ?`,
    )
      .bind(OWNER_DOC)
      .first<{ initializing_at: number | null }>();
    expect(row?.initializing_at).toBeNull();
  });
});

describe("R2 asset reaping on cancellation", () => {
  it("removes the abandoned attempt's R2 objects along with the row", async () => {
    // Uploads can land before the snapshot push fails; the row's FK
    // cascade only removes the asset ROWS, so cancellation must reap the
    // R2 objects too or they leak forever.
    const key = getDocumentAssetKey(OWNER_DOC, "orphan.png");
    await env.ASSETS.put(key, "bytes");
    const unrelatedKey = getDocumentAssetKey(FINALIZED_DOC, "keep.png");
    await env.ASSETS.put(unrelatedKey, "bytes");

    const app = appAsUser(ownerUserId);
    const res = await cancelInitialization(app, OWNER_DOC);
    expect(res.status).toBe(200);
    expect(await documentExists(OWNER_DOC)).toBe(false);
    expect(await env.ASSETS.get(key)).toBeNull();
    // Other documents' objects are untouched.
    expect(await env.ASSETS.get(unrelatedKey)).not.toBeNull();
  });
});
