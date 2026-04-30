import { Hono } from "hono";
import * as v from "valibot";
import { documentConnectParamSchema } from "../schemas";
import type { AppBindings } from "../types";

// `/api/connect/:documentId` — WebSocket upgrade for tldraw sync.
// Kept off the typed RPC chain because the handshake response is a
// raw `Response` (status 101 with `webSocket: ...`); the typed client
// doesn't reach websockets either way (clients open them via the
// browser `WebSocket` constructor with the URL). The handler still
// lives under `routes/` so the URL→file rule resolves uniformly.
export const connectRoutes = new Hono<AppBindings>().get(
  "/api/connect/:documentId",
  async (c) => {
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
    // initializing row's DO room hasn't been seeded with a snapshot
    // yet, so opening a sync session would have nothing to replicate
    // against and would race with the create flow's own snapshot
    // push.
    const document = await c.env.DB.prepare(
      `SELECT 1
       FROM documents
       WHERE id = ?
         AND workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)
         AND deleting_at IS NULL
         AND initializing_at IS NULL`,
    )
      .bind(documentId, userId)
      .first();

    if (!document) {
      return c.json({ error: "Not found" }, 404);
    }

    const room = c.env.DOCUMENT_SYNC_ROOM.getByName(documentId);

    // Unlike DO RPC calls, WebSocket upgrades enter through
    // DocumentSyncRoom.fetch(), which claims and validates the
    // document id from the already-validated request path before
    // accepting the socket.
    return room.fetch(c.req.raw);
  },
);

export type ConnectRoutes = typeof connectRoutes;
