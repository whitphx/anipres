import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepInitializingDocuments } from "./cleanup";
import { getDocumentAssetKey } from "./tldraw-assets";

// The sweep's grace window is 10 minutes; anything older is a candidate.
const STALE_AGE_MS = 11 * 60 * 1000;

// Fresh ids per test: the isolated-storage rollback between tests does
// NOT reset a live DO's in-memory fields, so reusing one document id
// (= one DO instance) would leak snapshotVersion state across tests.
let workspaceId: number;

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM documents`).run();
  await env.DB.prepare(`DELETE FROM workspaces`).run();
  await env.DB.prepare(`DELETE FROM users`).run();
  const owner = await env.DB.prepare(
    `INSERT INTO users DEFAULT VALUES RETURNING id`,
  ).first<{ id: number }>();
  const workspace = await env.DB.prepare(
    `INSERT INTO workspaces (name, owner_user_id) VALUES ('WS', ?) RETURNING id`,
  )
    .bind(owner!.id)
    .first<{ id: number }>();
  workspaceId = workspace!.id;
});

function insertDoc(
  id: string,
  fields: { initializingAt?: number | null; deletingAt?: number | null } = {},
) {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO documents (id, workspace_id, slug, title, sort_order, created_at, updated_at, initializing_at, deleting_at)
     VALUES (?, ?, ?, 'Doc', 'a0', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      workspaceId,
      `slug-${id.slice(-8)}`,
      now,
      now,
      fields.initializingAt ?? null,
      fields.deletingAt ?? null,
    )
    .run();
}

async function getDocState(id: string) {
  return env.DB.prepare(
    `SELECT initializing_at, deleting_at FROM documents WHERE id = ?`,
  )
    .bind(id)
    .first<{ initializing_at: number | null; deleting_at: number | null }>();
}

async function driveScheduledDeletion(id: string) {
  const room = env.DOCUMENT_SYNC_ROOM.getByName(id);
  for (let i = 0; i < 20 && (await getDocState(id)) !== null; i++) {
    await runInDurableObject(room, (instance) =>
      (instance as unknown as { alarm(): Promise<void> }).alarm(),
    );
  }
}

describe("sweepInitializingDocuments", () => {
  it("moves an abandoned document into the deletion lifecycle and its R2 objects get reaped", async () => {
    // The create flow uploaded an asset, then died before the snapshot
    // push. FK cascade would only remove the asset ROW; the R2 object
    // must go through the DO-driven prefix sweep or it leaks forever.
    const id = crypto.randomUUID();
    await insertDoc(id, { initializingAt: Date.now() - STALE_AGE_MS });
    const key = getDocumentAssetKey(id, "orphan.png");
    await env.ASSETS.put(key, "bytes");

    const result = await sweepInitializingDocuments(env);
    expect(result).toEqual({ reconciledCount: 0, deletedCount: 1 });
    // The sweep itself only transitions the row; the DO alarm loop
    // owns the R2 sweep and the final row delete.
    expect((await getDocState(id))?.deleting_at).not.toBeNull();

    await driveScheduledDeletion(id);
    expect(await getDocState(id)).toBeNull();
    expect(await env.ASSETS.get(key)).toBeNull();
  });

  it("reconciles a stale row whose DO already holds a snapshot instead of deleting it", async () => {
    const id = crypto.randomUUID();
    await insertDoc(id, { initializingAt: Date.now() - STALE_AGE_MS });
    const room = env.DOCUMENT_SYNC_ROOM.getByName(id);
    await runInDurableObject(room, async (instance) => {
      (instance as unknown as { snapshotVersion: number }).snapshotVersion = 3;
    });

    const result = await sweepInitializingDocuments(env);
    expect(result).toEqual({ reconciledCount: 1, deletedCount: 0 });
    const state = await getDocState(id);
    expect(state?.initializing_at).toBeNull();
    expect(state?.deleting_at).toBeNull();
  });

  it("leaves rows inside the grace window and rows already deleting alone", async () => {
    const freshId = crypto.randomUUID();
    await insertDoc(freshId, { initializingAt: Date.now() });
    // Already claimed by a cancellation — its DO alarm owns it; the
    // sweep must not re-schedule (or double-count) it.
    const deletingId = crypto.randomUUID();
    await insertDoc(deletingId, {
      initializingAt: Date.now() - STALE_AGE_MS,
      deletingAt: Date.now(),
    });

    const result = await sweepInitializingDocuments(env);
    expect(result).toEqual({ reconciledCount: 0, deletedCount: 0 });
    expect((await getDocState(freshId))?.initializing_at).not.toBeNull();
    expect((await getDocState(deletingId))?.deleting_at).not.toBeNull();
  });
});
