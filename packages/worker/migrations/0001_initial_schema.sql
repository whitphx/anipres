-- All timestamp columns are INTEGER Unix milliseconds. The default
-- expression `CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)`
-- gives sub-second precision and stays compact in indexes; aligns
-- with `0002_create_assets.sql` which uses the same convention.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  -- updated_at is unused today (no mutable user-level fields yet)
  -- but kept proactively. Backfilling timestamps into an existing
  -- table later is lossy — every existing row gets the migration
  -- time, erasing real "last touched" history. The cost of
  -- carrying the column from day one is trivial.
  updated_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- Refresh updated_at on every UPDATE that doesn't set it explicitly.
-- The WHEN guard means callers who *do* pass updated_at are honored;
-- everyone else gets a defensive auto-refresh. Recursion is a non-
-- issue: SQLite disables recursive triggers by default, and even
-- with recursive_triggers=ON the trigger's own UPDATE lands a fresh
-- timestamp so the WHEN guard fails on the second pass.
CREATE TRIGGER trg_users_updated_at AFTER UPDATE ON users
  FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE users
      SET updated_at = CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)
      WHERE id = OLD.id;
  END;

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
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- See `trg_users_updated_at` for the design notes; same shape applies.
CREATE TRIGGER trg_workspaces_updated_at AFTER UPDATE ON workspaces
  FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE workspaces
      SET updated_at = CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)
      WHERE id = OLD.id;
  END;

-- "List my workspaces" lookups via owner_user_id. Currently 1:1 so a
-- full scan would also be fine, but the index is cheap and pre-positions
-- us for Extension A (users owning multiple workspaces).
CREATE INDEX idx_workspaces_owner_user ON workspaces (owner_user_id);

-- documents.id design note:
--
-- This file picks TEXT UUID (client-allocated). That choice is *not*
-- universally correct for a document-management schema; it depends on
-- the sync architecture of the implementing system. Two viable shapes:
--
-- (A) TEXT UUID v7 (client-allocated) — chosen here
--     - The id is known the moment the client creates the document,
--       whether the client is online or offline. No server round-trip
--       to allocate it; the same id flows unchanged through the
--       local → synced migration path.
--     - Lets the API contract stay symmetric: every doc operation
--       (POST/PUT/GET/DELETE) addresses the doc by the id the client
--       already holds, so list/create/update share a clean shape.
--     - v7 specifically (vs v4) so the 48-bit time prefix keeps
--       B-tree inserts mostly-sequential. Recovers the locality
--       INTEGER rowids would have given us, modulo a constant
--       per-row size penalty.
--     - Trade: larger indexes (UUID is 36 chars vs 4–9 bytes for an
--       INTEGER rowid alias). Not measurable at hobby scale; real at
--       any future scale where index size compounds.
--
-- (B) INTEGER PRIMARY KEY AUTOINCREMENT (server-allocated)
--     - Smaller indexes, sequential B-tree inserts, and the PK is the
--       SQLite rowid (no separate PK index, every secondary index
--       stores rowid implicitly). Materially better on D1 at scale.
--     - Easier debugging in support tooling ("doc 42" vs a UUID).
--     - Trade: clients cannot create a synced document without a
--       round-trip to the server to allocate the id, and the
--       local → synced migration path needs an explicit id-remap
--       step that the client must thread through asset uploads,
--       snapshot pushes, and active-document tracking.
--
-- Implementors of similar schemas should evaluate their own sync
-- architecture before copying this choice. anipres picked UUID
-- because the local-first → synced migration is a first-class flow
-- and the simpler "id flows through the boundary" property matters
-- more here than the storage win.
CREATE TABLE documents (
  -- UUID v7 (RFC 9562) generated on the client. v7 over v4 because
  -- v7's 48-bit Unix-ms timestamp prefix makes B-tree inserts mostly
  -- sequential — recovering the rowid-alias-style locality that
  -- INTEGER AUTOINCREMENT would have given us — and gives a free
  -- creation-time secondary sort for debug/admin queries (the user-
  -- visible order is `sort_order`). CHECKed for the canonical 36-char
  -- form so a malformed id never lands in D1 even if the API-layer
  -- validator is bypassed.
  id                  TEXT    NOT NULL PRIMARY KEY
                              CHECK (length(id) = 36),
  -- ON DELETE RESTRICT (not CASCADE) on workspace_id: documents have
  -- a soft-delete + asset-GC lifecycle (see `deleting_at` below). A
  -- cascade from `workspaces` would hard-delete document rows
  -- directly, leaving R2 blobs orphaned and `DocumentSyncRoom` DOs
  -- with stale state. RESTRICT forces the application to drive each
  -- document through the proper deletion flow before its workspace
  -- can be removed.
  workspace_id        INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Every document has a slug from creation. The slug is the URL
  -- handle for both authorized access (the owner navigating to their
  -- own draft) and any future public access. UNIQUE+CHECK enforced
  -- on the column directly; SQLite auto-creates the unique index
  -- (named `sqlite_autoindex_documents_1`).
  slug                TEXT    NOT NULL UNIQUE CHECK (length(slug) > 0),
  -- title and `workspaces.name` use `length(trim(...)) > 0` (vs the
  -- plain length CHECK on slug/sort_order) because they're user-
  -- typed: whitespace-only inputs are a real hazard. valibot rejects
  -- these at the API layer too; this is the schema-layer backstop.
  title               TEXT    NOT NULL DEFAULT 'Untitled' CHECK (length(trim(title)) > 0),
  -- sort_order is a fractional-indexing key (the `fractional-indexing`
  -- npm package). Non-empty by construction; the CHECK enforces the
  -- contract at the schema layer.
  sort_order          TEXT    NOT NULL CHECK (length(sort_order) > 0),
  -- Non-null while deletion is in progress so uploads/connects stop
  -- treating the document as active before the final row removal
  -- happens (R2 asset GC needs a coordinated grace period).
  deleting_at         INTEGER,
  -- Non-null between the initial INSERT and the first successful
  -- snapshot push that finalizes the document. A document creation
  -- is a multi-step client flow:
  --
  --   1. POST /api/documents  → row inserted (this column = now)
  --   2. (optional) asset uploads to R2 under /:id/assets/...
  --   3. PUT /api/documents/:id/snapshot → DO room initialized
  --      and this column cleared
  --
  -- Initializing rows are excluded from list/get/update/delete so the
  -- client never sees a "half-built" document. A scheduled sweep
  -- hard-deletes rows whose `initializing_at` is older than the grace
  -- window — covers tab close, browser crash, hung network, and
  -- delete-mid-migration without any client cooperation.
  initializing_at     INTEGER,
  -- Defaulted to server time, but the convertLocalDocToSynced flow
  -- passes the original local creation timestamp explicitly so the
  -- doc list can sort by "actual creation date" rather than "synced
  -- date". Pure synced-creation (POST /api/documents) omits these
  -- and gets server time, matching `users` and `workspaces`.
  created_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
  updated_at          INTEGER NOT NULL DEFAULT (CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
);

-- See `trg_users_updated_at` for the design notes; same shape applies.
-- Callers who pass `updated_at` explicitly (snapshot push, the
-- convertLocalDocToSynced flow that preserves local timestamps) keep
-- their value because the WHEN guard fails. Callers who forget get
-- the auto-refresh.
CREATE TRIGGER trg_documents_updated_at AFTER UPDATE ON documents
  FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
  BEGIN
    UPDATE documents
      SET updated_at = CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)
      WHERE id = OLD.id;
  END;

-- Dominant query: "list active documents in a workspace, in sort
-- order." Active = neither deleting nor initializing — soft-deleted
-- rows wait out the asset-GC grace period; initializing rows wait
-- for the snapshot push (or the cleanup sweep). Both states are
-- excluded so the client only ever sees fully-realized documents.
CREATE INDEX idx_documents_workspace_sort
  ON documents (workspace_id, sort_order)
  WHERE deleting_at IS NULL AND initializing_at IS NULL;

-- FK lookup index. The composite above is partial, so it doesn't
-- cover queries that need to find documents regardless of lifecycle
-- state. Three paths benefit:
-- (a) the `ON DELETE RESTRICT` check fired when a workspace is
-- being deleted — SQLite has to confirm "no documents reference
-- this workspace_id" against *all* documents (active +
-- soft-deleted + initializing);
-- (b) any future query that intentionally looks at soft-deleted rows
-- (trash bin, GC sweep). Without this index, those fall back to a
-- full table scan;
-- (c) the initializing-row sweep (see `idx_documents_initializing`
-- below) only narrows by `initializing_at`; per-workspace sweeps
-- would still need the FK index.
CREATE INDEX idx_documents_workspace ON documents (workspace_id);

-- Sweep index: the scheduled cleanup query lists rows whose
-- `initializing_at` is older than the grace window. Partial on
-- `initializing_at IS NOT NULL` so the index stays empty in steady
-- state — the vast majority of rows have completed initialization
-- and contribute nothing to this index.
CREATE INDEX idx_documents_initializing
  ON documents (initializing_at)
  WHERE initializing_at IS NOT NULL;

-- =============================================================
-- Future extensions (not yet implemented)
-- =============================================================
-- Two independent extensions are anticipated; either can ship
-- before the other. There is one interaction point — see
-- Extension B's note on grantee_org_id — but the schemas don't
-- otherwise depend on each other.

-- -------------------------------------------------------------
-- Extension A: Organizations
-- -------------------------------------------------------------
--
-- Add `organizations` and `org_memberships` (members + roles) as
-- new tables. Rebuild `workspaces` so it can be owned by either a
-- user OR an org — nullable `owner_user_id`, new nullable
-- `owner_org_id`, and a CHECK enforcing exactly one. The data copy
-- during the rebuild is safe: every existing row has a non-null
-- `owner_user_id`, which satisfies the new CHECK with
-- `owner_org_id = NULL`.
--
-- Deletion semantics: deleting an org should cascade to its
-- workspaces, which will then trip the existing
-- `documents.workspace_id ON DELETE RESTRICT`. Same orchestration
-- as user deletion in the current schema — drive documents
-- through the proper soft-delete + asset-GC + hard-delete pipeline
-- before the org/workspace can be removed.

-- -------------------------------------------------------------
-- Extension B: Document sharing
-- -------------------------------------------------------------
--
-- Add `document_grants` — fully additive, no existing tables
-- modified. Each row grants a permission (`view` / `comment` /
-- `edit` / `manage`) on one document, scoped to either a specific
-- user, a specific org (only relevant if Extension A also lands),
-- or "anyone with the share link." The share-link case is
-- implemented as a `share_token` column whose value is a 24-byte
-- URL-safe random string; treat it as a security secret, not an
-- id (UUIDs aren't designed as unguessable tokens). A row-level
-- CHECK enforces "exactly one of (grantee_user, grantee_org,
-- share_token) is set."
--
-- Without Extension A: omit the grantee_org_id column and its
-- CHECK branch. With Extension A: include both. Either way, the
-- user-grant and share-link branches stand on their own.
--
-- Indexes the grants table will need: by `document_id` (resolve
-- "who has access to this doc?"), partial-by-grantee, partial-by-
-- token (lookups via share-link).

-- -------------------------------------------------------------
-- Conventions both extensions follow
-- -------------------------------------------------------------
--
-- Concrete table definitions are intentionally omitted: SQLite
-- syntax and our own conventions evolve, and a literal-SQL
-- skeleton here is more likely to bit-rot than to help. Implement
-- against the shape of the current schema:
--   * INTEGER PKs (rowid-aliased AUTOINCREMENT)
--   * INTEGER ms timestamps with the standard default expression
--     `CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)`
--   * `updated_at` triggers with the WHEN guard pattern
--   * `length(...) > 0` CHECKs (or `length(trim(...))` for
--     user-typed text)
--   * named indexes for FK lookups
--   * the SQLite `PRAGMA foreign_keys=OFF` rebuild dance for any
--     constraint change that requires a table rebuild
