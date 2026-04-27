/**
 * SQL fragment: filters a documents-row's `workspace_id` to one that
 * the requesting user owns. Always binds exactly one parameter at the
 * `?` placeholder position — the user id, as a number.
 *
 * Used as a WHERE-clause sub-condition. Templating (named parameters,
 * SQL builders) is not used; the `?` binding stays explicit at every
 * call site so the parameter order is locally visible.
 *
 * Phase 1 has 1:1 user:workspace, so this is equivalent to
 * "documents I own." Extension A (org-owned workspaces) will replace
 * this with a membership query against `workspaces` ∪
 * `org_memberships` — every call site is updated in a single sweep
 * by editing this constant.
 */
export const OWNED_WORKSPACE_FILTER =
  "workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ?)";
