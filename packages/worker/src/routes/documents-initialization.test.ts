import { env, runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppBindings } from "../types";
import { documentsRoutes } from "./documents";

// Route-level tests for DELETE /api/documents/:id/initialization
// against a real (miniflare) D1 with the production schema applied by
// the test setup file.

const OWNER_DOC = "019e0000-0000-7000-8000-000000000001";
const FINALIZED_DOC = "019e0000-0000-7000-8000-000000000002";
const FOREIGN_DOC = "019e0000-0000-7000-8000-000000000003";
const MISSING_DOC = "019e0000-0000-7000-8000-00000000000f";

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

async function documentExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM documents WHERE id = ?`)
    .bind(id)
    .first();
  return row !== null;
}

let ownerUserId: number;
let foreignUserId: number;

beforeEach(async () => {
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
  });
});
