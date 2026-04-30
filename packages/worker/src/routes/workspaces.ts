import { Hono } from "hono";
import type { AppBindings } from "../types";

// `/api/workspaces` — list-the-workspaces-I-own discovery endpoint.
// Phase 1 always returns exactly one row (the user's personal
// workspace, created at signup). Extension A will expand this to
// include workspaces the user belongs to via `org_memberships` —
// this becomes the canonical "what can I see?" discovery API.
export const workspacesRoutes = new Hono<AppBindings>().get(
  "/api/workspaces",
  async (c) => {
    const userId = c.get("userId");
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, created_at, updated_at
       FROM workspaces
       WHERE owner_user_id = ?
       ORDER BY id ASC`,
    )
      .bind(userId)
      .all<{
        id: number;
        name: string;
        created_at: number;
        updated_at: number;
      }>();
    return c.json(
      results.map((row) => ({
        id: String(row.id),
        name: row.name,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
      200,
    );
  },
);

export type WorkspacesRoutes = typeof workspacesRoutes;
