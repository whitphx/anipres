import { Hono } from "hono";
import type { AppBindings } from "../types";

// DB-row shape for the `workspaces` table as projected by this
// file's queries. Note `id: number` here vs `id: string` on the
// wire (the response below stringifies it) — see
// `workspaceIdSchema` in `../schemas.ts` for the symmetric request
// side. Named because every line of the handler reads better
// against this alias than a four-field inline shape.
type WorkspaceRow = {
  id: number;
  name: string;
  created_at: number;
  updated_at: number;
};

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
      .all<WorkspaceRow>();
    return c.json(
      results.map((row) => ({ ...row, id: String(row.id) })),
      200,
    );
  },
);

export type WorkspacesRoutes = typeof workspacesRoutes;
