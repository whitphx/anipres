CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE documents (
  id                  TEXT    PRIMARY KEY,
  workspace_id        TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  slug                TEXT    UNIQUE,
  title               TEXT    NOT NULL DEFAULT '',
  content             TEXT    NOT NULL DEFAULT '',
  sort_order          TEXT    NOT NULL,
  is_published        INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX idx_documents_workspace_sort ON documents (workspace_id, sort_order);
CREATE INDEX idx_documents_slug ON documents (slug) WHERE slug IS NOT NULL;

-- =============================================================
-- PHASE 2: Organizations (not yet implemented)
-- =============================================================
-- New tables (additive):
--
-- CREATE TABLE organizations (
--   id          TEXT PRIMARY KEY,
--   name        TEXT NOT NULL,
--   created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
--   updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
-- );
--
-- CREATE TABLE org_memberships (
--   org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
--   user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
--   created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
--   PRIMARY KEY (org_id, user_id)
-- );
--
-- CREATE INDEX idx_memberships_user ON org_memberships (user_id);
--
-- Rebuild workspaces to support org ownership (SQLite requires full table rebuild
-- to modify constraints):
--
-- CREATE TABLE workspaces_new (
--   id              TEXT PRIMARY KEY,
--   name            TEXT NOT NULL,
--   owner_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
--   owner_org_id    TEXT REFERENCES organizations(id) ON DELETE CASCADE,
--   created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
--   updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
--   CHECK (
--     (owner_user_id IS NOT NULL AND owner_org_id IS NULL) OR
--     (owner_user_id IS NULL     AND owner_org_id IS NOT NULL)
--   )
-- );
--
-- INSERT INTO workspaces_new
--   SELECT id, name, owner_user_id, NULL, created_at, updated_at FROM workspaces;
--
-- DROP TABLE workspaces;
-- ALTER TABLE workspaces_new RENAME TO workspaces;
--
-- The data copy is safe: all Phase 1 rows have non-null owner_user_id,
-- which satisfies the new CHECK constraint with owner_org_id = NULL.

-- =============================================================
-- PHASE 3: Document grants (not yet implemented)
-- =============================================================
-- Fully additive. No existing tables are modified.
--
-- CREATE TABLE document_grants (
--   id                TEXT PRIMARY KEY,
--   document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
--   grantee_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
--   grantee_org_id    TEXT REFERENCES organizations(id) ON DELETE CASCADE,
--   permission        TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit', 'manage')),
--   share_token       TEXT UNIQUE,   -- non-null = shareable link, no specific grantee
--   expires_at        TEXT,          -- null = never expires
--   created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
--   CHECK (
--     (grantee_user_id IS NOT NULL AND grantee_org_id IS NULL) OR
--     (grantee_user_id IS NULL     AND grantee_org_id IS NOT NULL) OR
--     (grantee_user_id IS NULL     AND grantee_org_id IS NULL AND share_token IS NOT NULL)
--   )
-- );
--
-- CREATE INDEX idx_grants_document ON document_grants (document_id);
-- CREATE INDEX idx_grants_user ON document_grants (grantee_user_id)
--   WHERE grantee_user_id IS NOT NULL;
-- CREATE INDEX idx_grants_token ON document_grants (share_token)
--   WHERE share_token IS NOT NULL;
