import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import * as z from "zod";
import { documentIdSchema } from "../schemas";
import type { AppBindings } from "../types";
import { getSyncAnimationDataVersionGateResponse } from "../animation-data-version-gate";

const documentConnectParamSchema = z.object({
  documentId: documentIdSchema,
});

// WebSocket upgrade for tldraw sync. The handshake returns a raw
// `Response`; clients open the socket via `new WebSocket(url)`
// rather than through the typed client.
export const connectRoutes = new Hono<AppBindings>().get(
  "/api/connect/:documentId",
  zValidator("param", documentConnectParamSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Invalid document id", details: result.error.issues },
        400,
      );
    }
  }),
  async (c) => {
    const versionGateResponse = getSyncAnimationDataVersionGateResponse(
      c.req.raw,
    );
    if (versionGateResponse) return versionGateResponse;
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected WebSocket upgrade", 426);
    }

    const userId = c.get("userId");
    const { documentId } = c.req.valid("param");

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
