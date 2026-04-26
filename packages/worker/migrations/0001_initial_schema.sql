-- All timestamp columns are INTEGER Unix milliseconds. The default
-- expression `CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)`
-- gives sub-second precision and stays compact in indexes; aligns
-- with `0002_create_assets.sql` which uses the same convention.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- OAuth identities. One user can have multiple identities (account
-- linking) — each row is one (provider, provider_id) pair owned by a
-- single user. PRIMARY KEY (provider, provider_id) enforces global
-- uniqueness across the OAuth space; idx_oauth_identities_user is for
-- "list this user's linked providers" lookups.
CREATE TABLE oauth_identities (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX idx_oauth_identities_user ON oauth_identities (user_id);

CREATE TABLE workspaces (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- documents.id design note:
--
-- This file picks INTEGER PRIMARY KEY AUTOINCREMENT (server-allocated).
-- That choice is *not* universally correct for a document-management
-- schema; it depends on the sync architecture of the implementing
-- system. Two viable shapes:
--
-- (A) INTEGER PRIMARY KEY AUTOINCREMENT (server-allocated) — chosen here
--     - Smaller indexes, sequential B-tree inserts, and the PK is the
--       SQLite rowid (no separate PK index, every secondary index
--       stores rowid implicitly). Materially better on D1.
--     - Easier debugging in support tooling ("doc 42" vs a UUID).
--     - Trade: clients cannot create a synced document without a
--       round-trip to the server to allocate the id, *or* must use
--       an explicit local→synced migration that remaps the locally
--       generated id to the server-allocated one.
--     - Right choice when the local→synced migration path is already
--       a first-class operation. anipres has this today as
--       `convertLocalDocToSynced` (packages/app/src/documents/migration.ts),
--       which can perform the id remap as part of the existing flow.
--
-- (B) TEXT UUID v7 (client-allocated)
--     - Documents can be created offline with their final id baked in.
--       No round-trip, no remap.
--     - Larger indexes (4–9× per FK reference), no rowid alias.
--     - Right choice when the sync contract is upsert-by-id and the
--       client owns the id lifecycle from creation onward.
--
-- Implementors of similar schemas should evaluate their own sync
-- architecture before copying this choice.
CREATE TABLE documents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id        INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  slug                TEXT    UNIQUE,
  title               TEXT    NOT NULL DEFAULT 'Untitled',
  content             TEXT    NOT NULL DEFAULT '',
  sort_order          TEXT    NOT NULL,
  is_published        INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  -- Non-null while deletion is in progress so uploads/connects stop
  -- treating the document as active before the final row removal
  -- happens (R2 asset GC needs a coordinated grace period).
  deleting_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_documents_workspace_sort ON documents (workspace_id, sort_order);
CREATE INDEX idx_documents_slug ON documents (slug) WHERE slug IS NOT NULL;

-- =============================================================
-- PHASE 2: Organizations (not yet implemented)
-- =============================================================
-- New tables (additive):
--
-- CREATE TABLE organizations (
--   id          INTEGER PRIMARY KEY AUTOINCREMENT,
--   name        TEXT NOT NULL,
--   created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
--   updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
-- );
--
-- CREATE TABLE org_memberships (
--   org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
--   user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--   role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
--   created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
--   PRIMARY KEY (org_id, user_id)
-- );
--
-- CREATE INDEX idx_memberships_user ON org_memberships (user_id);
--
-- Rebuild workspaces to support org ownership (SQLite requires full table rebuild
-- to modify constraints):
--
-- CREATE TABLE workspaces_new (
--   id              INTEGER PRIMARY KEY AUTOINCREMENT,
--   name            TEXT NOT NULL,
--   owner_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
--   owner_org_id    INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
--   created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
--   updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
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
--   id                INTEGER PRIMARY KEY AUTOINCREMENT,
--   document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
--   grantee_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
--   grantee_org_id    INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
--   permission        TEXT NOT NULL CHECK (permission IN ('view', 'comment', 'edit', 'manage')),
--   -- share_token is not an id; it's a security token. Mint as a
--   -- 24-byte URL-safe random string (~192 bits of entropy), not a
--   -- UUID. UUIDs aren't designed as unguessable secrets.
--   share_token       TEXT UNIQUE,   -- non-null = shareable link, no specific grantee
--   expires_at        INTEGER,       -- null = never expires
--   created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
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
