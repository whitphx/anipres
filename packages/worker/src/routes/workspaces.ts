import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../types";

type WorkspaceRow = {
  id: number;
  name: string;
  created_at: number;
  updated_at: number;
};

const workspaceIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d*$/u, "Invalid workspace id")
    .transform(Number),
});

export const workspacesRoutes = new Hono<AppBindings>()
  .get("/api/workspaces", async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, created_at, updated_at
       FROM workspaces
       WHERE owner_user_id = ?
       ORDER BY id ASC`,
    )
      .bind(userId)
      .all<WorkspaceRow>();
    return c.json(
      results.map((row) => ({ ...row, id: String(row.id) })),
      200,
    );
  })
  // SSE feed of workspace-scoped events. The only event today is
  // {"type":"documents:changed"} — the receiver re-fetches
  // /api/documents to get the current list. The stream stays open
  // for the lifetime of the EventSource; the client's auto-retry +
  // refreshInterval polling backstop covers any drop.
  .get(
    "/api/workspaces/:id/events",
    zValidator("param", workspaceIdParamSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "Invalid workspace id", details: result.error.issues },
          400,
        );
      }
    }),
    async (c) => {
      const userId = c.get("userId");
      const { id: workspaceId } = c.req.valid("param");

      const owns = await c.env.DB.prepare(
        "SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?",
      )
        .bind(workspaceId, userId)
        .first();
      if (!owns) {
        return c.json({ error: "Not found" }, 404);
      }

      // Per-tab id from the client (`?client_id=`). Used by the DO
      // to suppress fanOut to the originating tab on its own bumps.
      // EventSource has no header API, hence the query string.
      const clientId = c.req.query("client_id") ?? null;

      const ns = c.env.WORKSPACE_FEED_ROOM;
      const stub = ns.get(ns.idFromName(`workspace:${workspaceId}`));
      const stream = await stub.subscribe(clientId);

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          // Counter Cloudflare's response buffering for SSE so each
          // event line reaches the client immediately.
          "X-Accel-Buffering": "no",
        },
      });
    },
  );

export type WorkspacesRoutes = typeof workspacesRoutes;
