import { Hono } from "hono";
import type { AppBindings } from "../types";

type WorkspaceRow = {
  id: number;
  name: string;
  created_at: number;
  updated_at: number;
};

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
      .all<WorkspaceRow>();
    return c.json(
      results.map((row) => ({ ...row, id: String(row.id) })),
      200,
    );
  },
);

export type WorkspacesRoutes = typeof workspacesRoutes;
