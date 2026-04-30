import { vValidator } from "@hono/valibot-validator";
import { Hono } from "hono";
import * as v from "valibot";
import { documentIdSchema } from "../schemas";
import type { AppBindings } from "../types";

const documentConnectParamSchema = v.object({
  documentId: documentIdSchema,
});

// WebSocket upgrade for tldraw sync. The handshake returns a raw
// `Response`; clients open the socket via `new WebSocket(url)`
// rather than through the typed client.
export const connectRoutes = new Hono<AppBindings>().get(
  "/api/connect/:documentId",
  vValidator("param", documentConnectParamSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Invalid document id", details: result.issues },
        400,
      );
    }
  }),
  async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
      return c.text("Expected WebSocket upgrade", 426);
    }

    // SameSite=Lax already blocks cookies on cross-site WS upgrades
    // initiated by JS, but the Origin allowlist is cheap defense in
    // depth against CSWSH on browser quirks or non-Lax-honoring
    // clients. Hono's `csrf()` runs only on non-safe methods, so
    // this WS path needs its own check.
    const origin = c.req.header("Origin");
    if (!origin || origin !== c.env.PUBLIC_BASE_URL) {
      return c.json({ error: "Forbidden" }, 403);
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
