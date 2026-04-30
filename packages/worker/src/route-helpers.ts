import type { AppContext } from "./types";

// Slug generator. Phase 1 doesn't surface slugs in the UI; the column
// is populated for forward compatibility. crypto.randomUUID() is
// overkill for collision avoidance but keeps the call site one line
// and avoids pulling in nanoid. Swap to a shorter format when slugs
// become user-visible.
export function generateDocumentSlug() {
  return crypto.randomUUID();
}

// Centralized ownership check for workspace-scoped routes. Returns
// true iff the workspace exists and is owned by `userId`. Phase 1 has
// 1:1 user:workspace, so this is a presence check; Extension A will
// replace this with a membership query against `workspaces` ∪
// `org_memberships`.
export async function userOwnsWorkspace(
  c: AppContext,
  userId: number,
  workspaceId: number,
): Promise<boolean> {
  const row = await c.env.DB.prepare(
    "SELECT 1 FROM workspaces WHERE id = ? AND owner_user_id = ?",
  )
    .bind(workspaceId, userId)
    .first();
  return Boolean(row);
}
