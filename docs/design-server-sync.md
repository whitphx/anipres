# Design: Server-Side Login & Document Sync

> This document captures the design discussions for introducing server-side authentication,
> document persistence, and real-time synchronization to the anipres app.
> It was produced during a Claude Code session on 2026-03-13.

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
10. [Worker Structure](#worker-structure)
11. [Custom Shape Schema Sharing](#custom-shape-schema-sharing)
12. [Implementation Phases](#implementation-phases)
13. [Risks & Considerations](#risks--considerations)

---

## Current Architecture

- **Pure client-side SPA** deployed to Cloudflare Pages.
- Documents stored in **IndexedDB** via `idb-keyval` (`packages/app/src/documents/idb-repository.ts`).
- Clean `DocumentRepository` interface with `list`, `get`, `save`, `delete`.
- Document payload: `DocumentMeta` (id, title, createdAt, updatedAt, order) + `TLStoreSnapshot | null`.
- Auto-save: 500ms debounced writes to IndexedDB on store changes, plus flush on `visibilitychange`/`pagehide`/`beforeunload`.
- No backend, no authentication, no sync.

### Key Files

| File                                                    | Purpose                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/app/src/documents/types.ts`                   | `DocumentMeta`, `DocumentData` interfaces                                        |
| `packages/app/src/documents/idb-repository.ts`          | `IdbDocumentRepository` — IndexedDB persistence                                  |
| `packages/app/src/documents/useDocumentManager.ts`      | Main hook: CRUD, editor registration, auto-save                                  |
| `packages/app/src/documents/DocumentManagerContext.tsx` | React context + provider                                                         |
| `packages/app/src/AppContent.tsx`                       | Loads active document, renders `AnipresContainer` with `key={activeDocumentId}`  |
| `packages/anipres/src/Anipres.tsx`                      | tldraw wrapper with custom shapes (Slide, ThemeImage), animation/step management |

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

A one-time migration event, not a continuous toggle:

1. User has been working anonymously with documents in IndexedDB
2. User signs up / logs in
3. App detects local documents in IndexedDB
4. Prompt: "Upload N documents to your account?"
   - **Yes**: For each document:
     - Create D1 metadata entry
     - Provision Durable Object room
     - Load local snapshot via `SQLiteSyncStorage({ sql, snapshot })`
     - Clear local copy (or keep as cache)
   - **No / Later**: Keep local docs, start fresh on server
5. Remount editor with `useSync` (brief flash, acceptable for one-time event)

**Logging out**: Snapshot current store to IndexedDB, disconnect WebSocket, remount in local mode.

---

## API Design

```
# Auth
POST   /auth/login/:provider     -> Initiate OAuth
GET    /auth/callback/:provider   -> OAuth callback -> JWT
POST   /auth/logout
GET    /auth/me

# Document metadata (D1)
GET    /api/documents             -> List user's documents
POST   /api/documents             -> Create document (+ provision DO room)
PATCH  /api/documents/:id         -> Rename, reorder
DELETE /api/documents/:id         -> Delete document (+ destroy DO state)

# Sync (WebSocket, routed to Durable Object)
GET    /rooms/:id                 -> WebSocket upgrade -> TLSocketRoom

# Assets (R2)
POST   /api/assets                -> Upload file -> R2
GET    /api/assets/:key           -> Serve from R2 (edge-cached)
```

---

## Database Schema

### D1 (metadata only — snapshots live in Durable Object SQLite)

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,   -- UUID
  email         TEXT UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  provider      TEXT,               -- 'github' | 'google'
  provider_id   TEXT,
  created_at    INTEGER
);

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,   -- UUID, also the Durable Object room ID
  user_id       TEXT REFERENCES users(id),
  title         TEXT,
  "order"       REAL,
  created_at    INTEGER,
  updated_at    INTEGER
);
```

---

## Worker Structure

```
packages/
  worker/
    src/
      index.ts                    # Hono router: auth, REST, WebSocket upgrade
      durable-objects/
        TldrawRoom.ts             # DurableObject class wrapping TLSocketRoom + SQLiteSyncStorage
      routes/
        auth.ts                   # OAuth flows (GitHub, Google), JWT issuance
        documents.ts              # CRUD against D1
        assets.ts                 # R2 upload/download
      middleware/
        auth.ts                   # JWT verification
      schema.ts                   # createTLSchema with anipres custom shapes
    wrangler.toml                 # D1, R2, DO bindings
```

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

The `packages/anipres` library should export these schema definitions so the worker can import them. This may require a build change to produce a non-React bundle for the worker environment.

---

## Implementation Phases

### Phase 1 — Worker skeleton + document sync (no auth)

- Create `packages/worker` with Hono + wrangler config
- Implement `TldrawRoom` Durable Object with `TLSocketRoom` + `SQLiteSyncStorage`
- Wire up WebSocket upgrade route
- Client: add `useSync` path in `AnipresContainer`, toggled by a flag
- Verify real-time sync works between two browser tabs

### Phase 2 — D1 metadata + document management

- D1 schema + migrations for `documents` table
- REST routes for document CRUD
- Connect sidebar's document list to the API instead of IndexedDB
- Create/delete documents provisions/destroys Durable Object state

### Phase 3 — Authentication

- OAuth flow (GitHub + Google) in the Worker
- JWT session management
- `AuthContext` + login UI in the app
- Protect all API routes + WebSocket connections with auth middleware

### Phase 4 — Assets + migration

- R2 asset upload/download routes
- `TLAssetStore` implementation pointing to the Worker
- Local-to-cloud document migration flow on first login

### Phase 5 — Offline support + IDB cache

- 500ms debounced IDB cache during synced mode + flush on `visibilitychange`/`pagehide`
- Offline detection: if `useSync` can't connect, fall back to IDB cache in local mode
- Reconnection: push-or-fork logic comparing local vs server timestamps

### Phase 6 — Anonymous mode + polish

- Ensure anonymous mode (current IndexedDB path) stays intact alongside synced mode
- Online/offline indicator, reconnection UX
- User profile, account settings
- Rate limiting, input validation

---

## Risks & Considerations

- **Version pinning**: Client and server tldraw versions must match exactly. Pin both and deploy together.
- **Custom shape schema sharing**: `packages/anipres` must export shape props/migrations for the worker. May need a non-React build target.
- **Durable Object limits**: 128MB memory, 10GB SQLite per DO. More than enough for individual documents.
- **TODO: document deletion vs active rooms**: Deleting a document that still has an active sync room needs a future design for room invalidation and asset-reference coordination. The current worker intentionally does not try to close rooms or flush other rooms during delete, because doing that safely requires a bounded way to identify truly active rooms and to avoid deleting shared assets before their refs are persisted.
- **Offline data loss window**: Edits made in the last 500ms before a browser crash can be lost. Acceptable tradeoff.
- **Collaboration scope**: tldraw sync gives multi-cursor, real-time co-editing for free once Phase 1 is done.
- **Cost**: Cloudflare free tier is generous. Paid tier is very affordable at small-to-medium scale.
