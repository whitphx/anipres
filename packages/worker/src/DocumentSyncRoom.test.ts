import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function getRoom(name: string) {
  const id = env.DOCUMENT_SYNC_ROOM.idFromName(name);
  return env.DOCUMENT_SYNC_ROOM.get(id);
}

describe("DocumentSyncRoom", () => {
  describe("peekSnapshotVersion", () => {
    it("returns 0 for an unbound DO that has never received a snapshot", async () => {
      // The cleanup sweep contract: when a doc is stuck in
      // initializing_at and we ask the DO whether it ever got a
      // snapshot, an unbound DO should signal "never finalized" with
      // 0 — without throwing on the missing documentId.
      const room = getRoom("peek-unbound");
      expect(await room.peekSnapshotVersion()).toBe(0);
    });
  });

  describe("runRoomTask serialization", () => {
    it("runs queued tasks in submission order, one at a time", async () => {
      // The DO's runRoomTask serializes work against the room.
      // Concurrent submissions must not interleave: a slow first task
      // delays the start of the second. We exercise the lock from
      // inside the DO via runInDurableObject so we can call the
      // private method directly.
      const room = getRoom("ordering");
      const observed = await runInDurableObject(room, async (instance) => {
        const internals = instance as unknown as {
          runRoomTask: <T>(fn: () => Promise<T>) => Promise<T>;
        };
        const order: string[] = [];
        const slow = internals.runRoomTask(async () => {
          await new Promise((r) => setTimeout(r, 30));
          order.push("first-end");
        });
        const fast = internals.runRoomTask(async () => {
          order.push("second-start");
        });
        await Promise.all([slow, fast]);
        return order;
      });
      expect(observed).toEqual(["first-end", "second-start"]);
    });
  });

  describe("replaceSnapshot", () => {
    it("rejects with reason 'active-session' when the room has live WebSocket sessions", async () => {
      // The push-or-fork reconnect flow uses replaceSnapshot to
      // overwrite the DO's room snapshot with the client's offline
      // edits. If another client is live-editing the same doc, the
      // overwrite would clobber unsaved changes — so the call refuses
      // and the client falls back to the fork path. We simulate
      // active sessions by stubbing `getNumActiveSessions` from
      // inside the DO instance.
      const documentId = "019ddd16-daf3-7503-b6b3-1dbb0d34b95e";
      const room = getRoom("active-sessions-reject");
      await room.claimDocument(documentId);

      const result = await runInDurableObject(room, async (instance) => {
        const internals = instance as unknown as {
          room: { getNumActiveSessions: () => number };
        };
        const original = internals.room.getNumActiveSessions.bind(
          internals.room,
        );
        internals.room.getNumActiveSessions = () => 1;
        try {
          return await instance.replaceSnapshot({}, 0);
        } finally {
          internals.room.getNumActiveSessions = original;
        }
      });

      expect(result.replaced).toBe(false);
      expect(result.reason).toBe("active-session");
    });
  });
});
