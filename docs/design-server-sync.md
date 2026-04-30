# Design: Server-Side Login & Document Sync

> This document captures the design discussions for introducing server-side authentication,
> document persistence, and real-time synchronization to the anipres app.
> It was produced during a Claude Code session on 2026-03-13 and has since
> been kept in sync with the as-built shape of the system; sections that
> describe the implemented schema / API / worker layout reflect the code
> on `feature/sync-server` as of 2026-04-29.

## Status

All six implementation phases are landed on `feature/sync-server`. The remaining work is operational (deploy to real Cloudflare resources — see [`TODO.md`](./TODO.md) § Before first deploy) plus deferred follow-ups (merge two accounts on conflict, post-launch hardening). The OAuth flow has been exercised end-to-end locally; the next milestone is a preview deploy.

The implementation diverged from the original spec in a few load-bearing places — workspaces between users and documents (pre-positions Extension A), `oauth_identities` as a separate table for future account linking, INTEGER PKs for server-allocated entities (users, workspaces) but TEXT UUID v7 for documents (client-allocated), `initializing_at` / `deleting_at` lifecycle columns, a `tldraw_assets` GC table, and a single-endpoint PUT-as-upsert document API. The "Database Schema", "API Design", and "Worker Structure" sections below have been rewritten to match the as-built; the philosophy sections (Dual-Mode, Offline, etc.) describe decisions that survived intact.

## Table of Contents

1. [Current Architecture](#current-architecture)
2. [Goal](#goal)
3. [Infrastructure Choice](#infrastructure-choice)
4. [tldraw Sync Library](#tldraw-sync-library)
5. [Dual-Mode Architecture](#dual-mode-architecture)
6. [Offline Support](#offline-support)
7. [Anonymous to Logged-In Transition](#anonymous-to-logged-in-transition)
8. [API Design](#api-design)
9. [Database Schema](#database-schema)
10. [Document Lifecycle](#document-lifecycle)
11. [Worker Structure](#worker-structure)
12. [Custom Shape Schema Sharing](#custom-shape-schema-sharing)
13. [Implementation Phases](#implementation-phases)
14. [Risks & Considerations](#risks--considerations)

---

## Current Architecture

The local-only SPA described below was the starting point. The implementation now layers a Cloudflare Worker + D1 + R2 + Durable Objects on top — see the rest of this document — but the local repository, the `useDocumentManager` hook, and the IDB storage path are still present and active for the anonymous (logged-out) experience.

- Documents stored in **IndexedDB** via `idb-keyval` (`packages/app/src/documents/idb-repository.ts`).
- `DocumentRepository` interface with `list`, `get`, `save`, `delete`. The same interface backs the synced (server) path via `ApiDocumentRepository`.
- Document payload: `DocumentMeta` (id, title, slug?, sortOrder, createdAt, updatedAt, source) + `TLStoreSnapshot | null`. `sortOrder` is a fractional-indexing key (the `fractional-indexing` npm package); ids are UUID v7 minted client-side via the `uuid` package.
- Auto-save (local docs): 500ms debounced writes to IndexedDB on store changes, plus flush on `visibilitychange`/`pagehide`/`beforeunload`.

### Key Files

| File                                                     | Purpose                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/app/src/documents/types.ts`                    | `DocumentMeta`, `DocumentData`, `DocumentInput`, `DocumentSource`                |
| `packages/app/src/documents/idb-repository.ts`           | `IdbDocumentRepository` — IndexedDB persistence                                  |
| `packages/app/src/documents/api-repository.ts`           | `ApiDocumentRepository` — workspace-bound HTTP repository                        |
| `packages/app/src/documents/useDocumentManager.ts`       | Main hook: CRUD, editor registration, auto-save, convert-to-synced               |
| `packages/app/src/documents/DocumentManagerContext.tsx`  | React context + provider                                                         |
| `packages/app/src/documents/SyncedRepositoryContext.tsx` | React context for the workspace-bound synced repo                                |
| `packages/app/src/AppContent.tsx`                        | Loads active document, renders `AnipresContainer` with `key={activeDocumentId}`  |
| `packages/anipres/src/Anipres.tsx`                       | tldraw wrapper with custom shapes (Slide, ThemeImage), animation/step management |

---

## Goal

- Add server-side **user authentication** (OAuth: GitHub + Google).
- **Persist documents on the server** for logged-in users.
- Enable **real-time multi-user collaboration** on documents.
- Support **offline usage** — users can edit without connectivity, with reconciliation on reconnect.
- Allow **seamless transition** from anonymous (local-only) to logged-in (server-synced) mode.

---

## Infrastructure Choice

**Decision: Cloudflare Workers + D1 + R2 + Durable Objects**

The app already deploys to Cloudflare Pages. Keeping everything in the Cloudflare ecosystem minimizes ops burden.

| Component                | Technology                                  | Purpose                                                 |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------- |
| Edge router              | Cloudflare Worker (Hono)                    | HTTP routes, auth, WebSocket upgrade                    |
| Per-document sync        | Durable Object + `TLSocketRoom`             | One instance per document; real-time sync via WebSocket |
| Document persistence     | Durable Object SQLite + `SQLiteSyncStorage` | Each DO has its own SQLite; survives restarts           |
| Asset storage            | Cloudflare R2                               | Images, videos uploaded from tldraw                     |
| User accounts & doc list | D1 (SQLite)                                 | User table, document metadata, ownership                |
| Auth                     | OAuth (GitHub/Google) via Worker            | JWT tokens                                              |

### Cost (free tier)

- Workers: 100K requests/day
- D1: 5M reads, 100K writes/day
- R2: 10GB storage
- Durable Objects: $0.15/million requests + $0.50/GB-month storage

---

## tldraw Sync Library

**Decision: Use `@tldraw/sync` + `@tldraw/sync-core` for real-time collaboration.**

Reference: https://tldraw.dev/docs/sync
Cloudflare template: https://github.com/tldraw/tldraw-sync-cloudflare

### How It Works

- **`useSync` hook** (client): creates a store connected to a server via WebSocket.
- **`TLSocketRoom`** (server): maintains authoritative in-memory document state, broadcasts changes.
- **`SQLiteSyncStorage`** (server): persists room state in SQLite (Durable Object's built-in SQLite).
- **`ClientWebSocketAdapter`**: auto-reconnects with exponential backoff (500ms–5min).

### `useSync` Return States

```typescript
{ status: 'loading' }                                         // No store yet
{ status: 'error', error: TLRemoteSyncError }                 // Fatal error
{ status: 'synced-remote', connectionStatus: 'online' | 'offline', store: TLStore }
```

### Critical Behavior of `useSync`

1. **Cannot produce a usable store without at least one successful server connection.** Stays in `{ status: 'loading' }` forever if WebSocket never connects. No timeout, no fallback.

2. **After initial connection, editing during disconnection works.** Local edits go into `speculativeChanges` buffer (in-memory). The store remains usable with `connectionStatus: 'offline'`.

3. **Reconnection uses a rebase model** (like `git rebase`):
   - Stash local `speculativeChanges`
   - Undo them from the store
   - Apply server diff (incremental or full wipe)
   - Re-apply stashed local changes on top
   - Push rebased changes to server
   - This is optimistic, last-writer-wins at the record level.

4. **`speculativeChanges` are in-memory only.** Closing the tab while offline **loses all buffered edits**. `useSync` has no built-in IndexedDB persistence.

---

## Dual-Mode Architecture

Since `useSync` cannot work fully offline, we need two editor modes:

### Three Editor Modes

| Mode        | When                           | Store creation                           | Persistence                              |
| ----------- | ------------------------------ | ---------------------------------------- | ---------------------------------------- |
| **Local**   | Anonymous, or logged-out       | `<Tldraw snapshot={...}>`                | IndexedDB (current code)                 |
| **Synced**  | Logged in + online             | `<Tldraw store={useSync(...)}>`          | Durable Object via WebSocket + IDB cache |
| **Offline** | Logged in + app starts offline | `<Tldraw snapshot={...}>` from IDB cache | IndexedDB, reconcile on reconnect        |

### Pseudocode

```tsx
function AnipresContainer({ documentId }) {
  const { isLoggedIn } = useAuth()
  const isOnline = useOnlineStatus()
  const idbRepo = useIdbRepository()

  const mode = !isLoggedIn ? 'local'
             : isOnline    ? 'synced'
             :               'offline'

  if (mode === 'synced') {
    return <SyncedEditor documentId={documentId} idbRepo={idbRepo} />
  } else {
    return <LocalEditor documentId={documentId} idbRepo={idbRepo} />
  }
}

function SyncedEditor({ documentId, idbRepo }) {
  const store = useSync({
    uri: `wss://api.anipres.app/rooms/${documentId}`,
    assets: assetStore,
    shapeUtils: [...],
  })
  useCacheToIdb(store, documentId, idbRepo) // 500ms debounced cache
  return <Tldraw store={store} />
}

function LocalEditor({ documentId, idbRepo }) {
  const snapshot = useSnapshot(documentId, idbRepo)
  return <Tldraw snapshot={snapshot} onMount={registerEditor} />
}
```

---

## Offline Support

### IDB Cache in Synced Mode

While connected via `useSync`, periodically snapshot the store to IndexedDB:

- **500ms debounced** (same interval as current local auto-save)
- **Flush on `visibilitychange` / `pagehide`** (catches tab close)
- This ensures a recent local copy always exists for offline fallback

### Scenarios and Resolution

| Scenario                                | What happens                                  | Resolution                                 |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Online, real-time editing               | `useSync` handles everything                  | Automatic (rebase)                         |
| Goes offline mid-session, keeps editing | `speculativeChanges` in memory                | `useSync` rebases on reconnect             |
| Closes tab while offline                | `speculativeChanges` lost, IDB cache survives | Load from IDB on reopen                    |
| App starts while offline                | `useSync` can't connect, stays `loading`      | Load from IDB cache, run in local mode     |
| Back online after offline session       | Compare local vs server state                 | Push if server unchanged; fork if diverged |

### Fork-on-Conflict Logic

```
Back online after offline editing
  |
  +-- Fetch server's updatedAt for this document
  |
  +-- Server unchanged since we went offline?
  |     +-- Yes: Push local snapshot to server, switch to useSync
  |
  +-- Server has newer changes?
        +-- Fork: Save local version as "[title] (offline copy)"
        +-- Reconnect original document via useSync (gets server version)
        +-- User can manually compare and merge
```

### Why Fork Instead of Merge

When the app starts offline, the local snapshot was loaded into a regular tldraw store (not `useSync`). There is no shared `lastServerClock` baseline, so `useSync`'s record-level rebase is not possible. Two independent snapshots can only be compared at the document level. Forking is the safe, honest choice — no silent data loss.

### Two Different Kinds of "Conflict"

|             | Real-time conflict (useSync)            | Offline divergence (our fork logic)       |
| ----------- | --------------------------------------- | ----------------------------------------- |
| When        | Both users online simultaneously        | User edits offline, others edit on server |
| Mechanism   | WebSocket — changes stream continuously | No connection — independent histories     |
| Granularity | Per-record (individual shapes)          | Whole document snapshot                   |
| Resolution  | Rebase (last-writer-wins per record)    | Push or fork                              |

These are complementary, not conflicting. `useSync` handles 90% of sync; our fork logic handles the cold-start-while-offline edge case.

---

## Anonymous to Logged-In Transition

Not a one-shot batch — the implementation makes the transition per-document, opt-in, and idempotent.

After login, local docs continue to live in IDB and show up in the sidebar alongside synced docs (separated visually by source). Each local doc gets a "Migrate this document" button that runs `convertLocalDocToSynced` (`packages/app/src/documents/migration.ts`):

1. Read the local doc.
2. Compute a fractional-indexing key past the synced list's tail.
3. `PUT /api/documents/:id` (server inserts under the local UUID, marks `initializing_at`).
4. Upload any inline `data:` URL assets to R2 via `POST /api/documents/:id/assets`, rewriting the snapshot's asset srcs.
5. `PUT /api/documents/:id/snapshot` (DO room seeded; `initializing_at` cleared).
6. Delete the local IDB entry.

UUID v7 client-allocation means `localId === serverId` — no remap, no active-doc id swap. On failure after step 3 the local copy is preserved so the user can retry; the half-created server row stays hidden behind `initializing_at` and is reaped by the sweep if the user gives up entirely. If the user deletes a doc mid-migration, the migration's `AbortController` cancels and `deleteDocument` runs a one-line `syncedRepository.delete(id)` cleanup (`localId === serverId` makes this trivial).

**Logging out**: clear the session cookie. The `OfflineAwareSyncedContainer` unmounts; synced docs disappear from the sidebar; local docs (if any) remain. No data movement on logout — everything synced lives on the server.

---

## API Design

The shipped contract diverges from the original sketch in two load-bearing places: a single PUT-as-upsert replaces the POST + PATCH split, and document operations are workspace-scoped (every list/save names a `workspace_id`).

```
# Auth (cookie-session JWT, same-origin, HS256)
GET    /auth/github                   -> OAuth flow + callback (one route via @hono/oauth-providers)
GET    /auth/google                   -> OAuth flow
GET    /auth/google/callback          -> OAuth callback
POST   /auth/logout                   -> Clear session cookie
GET    /auth/me                       -> Current user id
GET    /auth/identities               -> List the OAuth identities linked to the current user
DELETE /auth/identities/:provider/:provider_id  -> Unlink an OAuth identity (refused if it's the user's last one)

# Workspaces (Phase 1 invariant: 1:1 user ↔ workspace)
GET    /api/workspaces                -> List workspaces the user owns

# Documents (workspace-scoped; PUT-as-upsert)
GET    /api/documents?workspace_id=:wsid     -> List active docs in a workspace
GET    /api/documents/:id                    -> Read one doc's metadata
PUT    /api/documents/:id                    -> Upsert (insert if new, update if existing)
DELETE /api/documents/:id                    -> Soft-delete (R2 GC + final row removal happens after grace)

# Document lifecycle
POST   /api/documents/:id/finalize           -> Clear initializing_at without seeding the DO room
PUT    /api/documents/:id/snapshot           -> Push a snapshot into the DO room (used by migration + reconnect-fork)
GET    /api/documents/:id/snapshot-status    -> Server-side snapshot version (for offline reconcile)
GET    /api/documents/:id/offline-cache      -> Latest cached snapshot (for offline cold-start)

# Sync (WebSocket → Durable Object)
GET    /api/connect/:documentId              -> WebSocket upgrade -> DocumentSyncRoom

# Assets (R2 via the worker; document-scoped)
POST   /api/documents/:id/assets             -> Upload, server allocates UUID v4 asset name
GET    /api/documents/:id/assets/:assetName  -> Serve the asset
```

Notes:

- **PUT-as-upsert** lets the client mint the doc id (UUID v7) up front and use the same call shape on first save and every later save. The server inserts (with `initializing_at` set) on first sight, updates otherwise. Rejects state transitions (cross-workspace move, save-while-deleting, save-while-initializing) as 404 from the client's perspective.
- **`workspace_id` is always required on list/save** even though Phase 1 has 1:1 user ↔ workspace. The client passes the workspace id resolved from `GET /api/workspaces`. Per-doc routes (`get`, `delete`, snapshot, finalize) don't need it because the doc id implicitly identifies its workspace; the server still verifies ownership.
- **`/api/connect/:documentId`** runs through the same `requireSession` middleware as the REST routes — only logged-in users can open a sync session.
- **Typed client** — every JSON endpoint above is consumed via Hono's `hc<AppType>()` so the app reads response shapes from the worker's compiled `.d.ts`. The worker emits its declarations through a TypeScript project reference (`packages/worker/tsconfig.build.json`); the app's `tsc -b` builds the worker first.
- **CSRF protection** — Hono's `csrf()` middleware allowlists `Origin` against `PUBLIC_BASE_URL` for state-changing requests. JSON requests are protected by browser-level CORS preflight (the worker emits no `Access-Control-Allow-Origin`); WebSocket upgrades are blocked by `SameSite=Lax` on the session cookie.

---

## Database Schema

### D1 (metadata only — snapshots live in Durable Object SQLite)

The implemented schema is in `packages/worker/migrations/0001_initial_schema.sql` and `0002_create_tldraw_assets.sql`. The shape:

```
users (INTEGER PK)
  └─ workspaces (INTEGER PK, owner_user_id FK)
       └─ documents (TEXT UUID v7 PK, workspace_id FK,
                     slug TEXT UNIQUE, sort_order TEXT,
                     deleting_at, initializing_at, created_at, updated_at)
                          └─ tldraw_assets (document_id FK, asset_name,
                                            last_seen_at, stale_at)

oauth_identities (composite PK (provider, provider_id), user_id FK)
```

Decisions worth knowing:

- **INTEGER PKs for users / workspaces** — server-allocated, never user-facing in URLs, smaller indexes, sequential B-tree inserts. Asymmetric with documents.
- **TEXT UUID v7 PK for documents (client-allocated)** — the local→synced migration is a first-class flow, and the same id flowing unchanged through IDB → POST → asset uploads → snapshot push is the simplification that lets the migration stay one screen of code. v7 over v4 because the 48-bit time prefix keeps B-tree inserts mostly-sequential, recovering most of the locality an INTEGER would have given. The full design discussion (UUID vs INTEGER trade-offs, the `slug` distinction) lives in the doc-comment block at the top of `documents` in the migration file.
- **Workspaces between users and documents** — pre-positions Extension A (org-owned workspaces, multi-member) without rewriting the document handlers. Phase 1 invariant: every user has exactly one personal workspace, created on first login.
- **`oauth_identities` separate table** — pre-positions account linking (GitHub + Google on one user) without rewriting the OAuth handlers. Composite PK `(provider, provider_id)` enforces global identity uniqueness and gives the parallel-login race a clean failure mode (loser trips the PK, rolls back its orphan user, re-selects the canonical user_id).
- **`initializing_at` / `deleting_at`** — explicit lifecycle states for multi-step create and delete flows. See [Document Lifecycle](#document-lifecycle).
- **`tldraw_assets` GC table** — per-document asset registry with `last_seen_at` (refreshed on every snapshot push that still references the asset) and `stale_at` (set when the asset drops out of the snapshot). A grace period after `stale_at` lets undo/redo recover the asset; afterward the worker GCs the R2 blob.
- **`updated_at` triggers** with a `WHEN NEW.updated_at IS OLD.updated_at` guard — auto-stamp callers who forget, honor callers who pass it explicitly (the local→synced migration preserves on-device timestamps).
- **`updated_at` is dropped from the wire** — the API never accepts `updated_at` on PUT; the trigger handles it. Clients only decide _what_ changed (title, sortOrder); the server (or repo, on the local side) decides _when_.

---

## Document Lifecycle

Document creation and deletion are multi-step flows. The schema makes both states explicit so a half-finished operation can never appear to the client as a real document.

### Creation

```
PUT  /api/documents/:id            →  row inserted with initializing_at = now()
   (optional) POST /api/documents/:id/assets...  →  inline data: URLs uploaded to R2
PUT  /api/documents/:id/snapshot   →  DO room initialized + initializing_at cleared
   (or, for empty fresh creates)
POST /api/documents/:id/finalize   →  initializing_at cleared without seeding the DO
```

Initializing rows are excluded from list/get/update/delete (the partial index `idx_documents_workspace_sort` filters them out and the handlers re-assert the predicate). The client never sees a half-built doc.

If the client gives up between insert and finalize (tab close, crash, network failure, delete-mid-migration), the row lingers as `initializing_at IS NOT NULL`. A scheduled cron (`*/5 * * * *`, see `wrangler.toml`) runs `sweepInitializingDocuments` (`packages/worker/src/cleanup.ts`) which, after a 10-minute grace window, either:

- **Reconciles** — DO has a snapshot (`peekSnapshotVersion > 0`), meaning the snapshot push succeeded but the D1 UPDATE that should have cleared `initializing_at` never landed. Clear the flag.
- **Deletes** — DO has no snapshot. Genuinely abandoned; hard-delete the row, FK cascade cleans up `tldraw_assets`.

The fresh-create path uses `/finalize` (no DO touch) instead of pushing an empty snapshot client-side, because synthesizing a valid empty `TLStoreSnapshot` requires reconstructing tldraw's schema descriptor and would pre-seed the DO room — pre-empting `useSync`'s natural "populate on first connect" path.

### Deletion

`DELETE /api/documents/:id` flips `deleting_at = now()` rather than removing the row. The DO claims the document and starts a soft-delete timeline:

1. Stop accepting WebSocket connections (the DO returns an error).
2. After a short grace, GC the document's R2 assets via the `tldraw_assets` table.
3. Hard-delete the D1 row (FK cascade removes the `tldraw_assets` rows).

This avoids racing R2 cleanup against an in-flight upload from a still-connected client, and handles the case where another client is mid-WebSocket-session against the soon-to-be-deleted doc.

The `deleting_at` and `initializing_at` filters appear in every read path, so the client cannot accidentally see a row in either intermediate state.

### Asset GC

Each `tldraw_assets` row records `last_seen_at` (refreshed when a snapshot push still references the asset) and `stale_at` (set when the asset drops out of the snapshot). After a grace window past `stale_at`, the GC sweep deletes the R2 blob and removes the row. The grace period exists so undo / redo can still bring a deleted asset back without re-uploading.

---

## Worker Structure

```
packages/worker/
  src/
    worker.ts                # Hono entry: mounts middleware (csrf, oauth, api-auth) and the chained sub-routers; AppType export for the typed RPC client
    api-types.ts             # Type-only re-export for the app's hc<AppType>() consumer
    DocumentSyncRoom.ts      # DurableObject wrapping TLSocketRoom + SQLiteSyncStorage; soft-delete timeline
    tldraw-assets.ts         # Asset lifecycle helpers (GC sweeps, snapshot/asset reconciliation, startDocumentDeletion)
    tldraw-asset-policy.ts   # Cross-package MAX_ASSET_SIZE constant
    cleanup.ts               # sweepInitializingDocuments — runs from the scheduled cron
    schemas.ts               # Cross-cutting valibot schemas (documentIdSchema, assetNameSchema, …); single-route schemas live next to their handlers
    types.ts                 # AppBindings, AppContext, Env type aliases
    routes/
      auth.ts                # /auth/me, /auth/logout, /auth/identities, /auth/identities/:provider/:provider_id
      workspaces.ts          # /api/workspaces
      documents.ts           # /api/documents (list, get, upsert, delete, finalize, snapshot, …)
      document-assets.ts     # /api/documents/:id/assets (multipart upload + asset read)
      connect.ts             # /api/connect/:documentId — WebSocket upgrade
    auth/
      index.ts               # registerOAuthProviderRoutes (browser-redirect handlers), registerApiAuth (JWT middleware)
      session.ts             # JWT issue + verify, oauth_identities resolve, parallel-login race handling, identity list / revoke
      github.ts              # GitHub OAuth (via @hono/oauth-providers/github)
      google.ts              # Google OAuth (manual: state cookie + access-token + userinfo `sub`)
  migrations/
    0001_initial_schema.sql           # users, oauth_identities, workspaces, documents
    0002_create_tldraw_assets.sql     # tldraw_assets GC table
  vitest.config.ts                    # @cloudflare/vitest-pool-workers config (DO tests run in workerd)
  wrangler.toml                       # bindings + scheduled trigger + preview env
```

The custom-shape schema for `TLSocketRoom`'s record validation lives in `packages/anipres` and is imported by both the app and the worker — see [Custom Shape Schema Sharing](#custom-shape-schema-sharing).

---

## Custom Shape Schema Sharing

Anipres has custom shapes (Slide, ThemeImage). Both client and server must share the same schema for `TLSocketRoom` to validate records:

```typescript
// Shared (imported by both client and worker)
import { createTLSchema } from "tldraw";

export const anipresSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    slide: { props: slideShapeProps, migrations: slideShapeMigrations },
    "theme-image": { props: themeImageProps, migrations: themeImageMigrations },
  },
});
```

The `packages/anipres` library exports the shape schema descriptors via `anipres/schema` (a non-React entry point). The worker imports `slideShapeProps`, `themeImageShapeProps`, and the corresponding type-name constants from there and reconstructs `createTLSchema` locally — see `packages/worker/src/DocumentSyncRoom.ts`.

---

## Implementation Phases

### Phase 1 — Worker skeleton + document sync (no auth) ✅

- `packages/worker` with Hono + wrangler config
- `DocumentSyncRoom` Durable Object wrapping `TLSocketRoom` + `SQLiteSyncStorage`
- WebSocket upgrade route (now at `/api/connect/:documentId`, behind auth)
- Client: `useSync` path in `OfflineAwareSyncedContainer` and `SyncedAnipresContainer`
- Real-time sync verified between browser tabs

### Phase 2 — D1 metadata + document management ✅

- D1 schema + migrations (`0001_initial_schema.sql`)
- REST routes for document CRUD as PUT-as-upsert (`worker.ts`)
- Sidebar's document list reads from `ApiDocumentRepository`
- Soft-delete + asset GC + sweep replaces the original "delete = destroy DO state" plan; see [Document Lifecycle](#document-lifecycle)

### Phase 3 — Authentication ✅

- OAuth flow for GitHub (via `@hono/oauth-providers`) and Google (hand-rolled: per-provider state cookie + access-token exchange + userinfo `sub` lookup, because the `@hono/oauth-providers` Google flow posts a token payload Google rejects)
- JWT cookie-session in `auth/session.ts` (HS256, 7-day expiry, HttpOnly + Secure + SameSite=Lax)
- `AuthContext` + login UI in the app sidebar footer
- `requireSession` middleware protects every `/api/*` route including the WebSocket upgrade
- `oauth_identities` separate table — pre-positions account linking (see [TODO.md](./TODO.md))

### Phase 4 — Assets + migration ✅

- Document-scoped R2 asset upload/download routes (`routes/document-assets.ts`); asset GC + lifecycle helpers in `tldraw-assets.ts`
- `TLAssetStore` implementation in the app pointing at the Worker
- `convertLocalDocToSynced` migration: client-allocated UUID v7 means the local id flows unchanged through every step (POST → asset uploads → snapshot push → IDB delete); see `packages/app/src/documents/migration.ts`

### Phase 5 — Offline support + IDB cache ✅

- 500ms debounced IDB cache during synced mode (`OfflineAwareSyncedContainer` + `idb-sync-cache.ts`); flush on `visibilitychange`/`pagehide`
- Offline cold-start path: `GET /api/documents/:id/offline-cache` falls back to local IDB cache when the network is unreachable
- Reconnect (`reconcileOfflineEdits` in `reconnect.ts`): push-or-fork against the server's snapshot version. Fork mints a new UUID v7 client-side and lands past the synced list's tail.

### Phase 6 — Anonymous mode + polish ✅

- Anonymous mode (IDB-only) preserved alongside synced mode; `DocumentManagerProvider` accepts an optional `syncedRepository`
- Online/offline indicator + reconnect banner (`NetworkStatus`)
- Convert-to-synced UX: per-doc spinner / error / retry; friendly error-message mapping (`getConversionErrorMessage` in `documents/conversion-error-message.ts`); polite `aria-live` region for screen-reader announcements; asset-upload concurrency cap (`ASSET_UPLOAD_CONCURRENCY = 4`, work-stealing pattern)
- Input validation: valibot schemas at the worker boundary, with worker-side test pipeline
- Workspace-discovery error UI (visible message instead of blank screen)
- Account-settings modal opened from the sidebar's `AccountFooter`; lists linked OAuth identities (`GET /auth/identities`); fetches via SWR with focus-revalidation
- Account linking — existing OAuth callbacks branch on the session cookie: a logged-in user completing the OAuth dance attaches the new `(provider, provider_id)` to the current `user_id` (via `attachIdentityToCurrentUser` in `auth/session.ts`); a logged-out user follows the existing login flow. Conflict ("provider account already linked to a different user") surfaces as a redirect-flash error.
- Disconnect a linked provider — `DELETE /auth/identities/:provider/:provider_id` with a server-side "can't remove your last sign-in method" guard (atomic single-statement check via subquery); two-click in-row Confirm/Cancel UI in the settings modal
- SWR migration of all auth-context fetches (`/auth/me`, `/auth/identities`, `/api/workspaces`); cache-wipe on logout via `globalMutate(() => true, …)` so no auth-scoped data lingers post-session
- OAuth cookie / redirect_uri robustness: cookies use conditional `secure` attribute (HTTPS-only in prod, accepted on HTTP localhost); Google `redirect_uri` derived from explicit `PUBLIC_BASE_URL` env var (per-environment, see `.dev.vars.example` for local setup); per-failure-path logging in the Google callback for debuggable misconfigurations; localhost-vs-prod sanity check throws clearly if a developer forgets `.dev.vars`
- Typed RPC across every JSON endpoint via Hono's `hc<AppType>()`. Worker emits `.d.ts` through a TypeScript project reference (`tsconfig.build.json`) so the app consumes pre-compiled types instead of walking worker source; route files live under `packages/worker/src/routes/<url-segment>.ts` and chain into `worker.ts`'s `app.route(...)`
- CSRF protection via Hono's built-in `csrf()` middleware, allowlisting `Origin` against `PUBLIC_BASE_URL` for state-changing requests; JSON requests are blocked by browser CORS preflight (no `Access-Control-Allow-Origin` is emitted), and WebSocket upgrades are blocked by `SameSite=Lax` on the session cookie
- DocumentSyncRoom test pipeline via `@cloudflare/vitest-pool-workers`, exercising the highest-leverage concurrency paths (`peekSnapshotVersion` against an unbound DO, `runRoomTask` ordering, `replaceSnapshot` rejection on active sessions)

Deferred (see [TODO.md](./TODO.md)):

- Merge two accounts on conflict (a meaningfully bigger feature; tracked separately)

(Rate limiting was originally listed under Phase 6; see [Post-Launch Hardening](./TODO.md#post-launch-hardening) in TODO.md for why it moved.)

---

## Post-Launch Hardening

Items intentionally deferred from the pre-launch phases. The cost of skipping each is bounded at the current alpha-internal scale; revisit before opening to a real user base.

### Rate limiting

Every authenticated endpoint is currently unbounded per user. Worst-case abuse is bounded by:

- Cloudflare Workers' daily request quota (100K/day on free tier; 10M/day on paid).
- An estimated $50–100/month of R2/D1 overage in a sustained-attack scenario.

Both are visible in the Cloudflare billing dashboard before they become painful. Anonymous endpoints (auth callbacks) sit behind Cloudflare's free edge DDoS protection.

When this gets implemented:

- Per-user keyed via the Workers Rate Limiting API binding.
- Separate namespace per top-cost endpoint (asset upload, snapshot push, document create).
- 429 response with `Retry-After`.
- Client-side surfacing through the existing `conversionErrors` channel for the convert-to-synced flow; similar treatment for other write paths.

### Operational alerting

Independent of rate limiting and worth doing before any public open:

- Cloudflare billing alerts at 50 / 80 / 100% of paid-tier-trigger spend.
- R2 storage growth alarm.
- Workers analytics dashboard review for unusual per-route request volume.

---

## Risks & Considerations

- **Version pinning**: Client and server tldraw versions must match exactly. Pin both and deploy together.
- **Custom shape schema sharing**: `packages/anipres` must export shape props/migrations for the worker. May need a non-React build target.
- **Durable Object limits**: 128MB memory, 10GB SQLite per DO. More than enough for individual documents.
- **Document deletion vs active rooms** (resolved): `DELETE` flips `deleting_at` rather than removing the row; the DO claims the document, stops accepting connections, and runs the asset-GC + final-row-removal timeline. See [Document Lifecycle](#document-lifecycle).
- **Offline data loss window**: Edits made in the last 500ms before a browser crash can be lost. Acceptable tradeoff.
- **Collaboration scope**: tldraw sync gives multi-cursor, real-time co-editing for free once Phase 1 is done.
- **Cost**: Cloudflare free tier is generous. Paid tier is very affordable at small-to-medium scale.
