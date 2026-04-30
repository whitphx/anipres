# ID Design — Proposed Revisions to the Phase 1 Schema

> **Status (post-implementation):** kept here as a record of the design discussion. The as-built schema diverged on one point — `documents.id` stayed TEXT UUID v7 (client-allocated) rather than moving to INTEGER as proposed below — because the local→synced migration flow was simplest with the same id flowing unchanged from the client through every step. See the top design comment on `documents` in `packages/worker/migrations/0001_initial_schema.sql` for the as-built rationale. The other proposals (INTEGER PKs for `users` / `workspaces`, composite PK for `oauth_identities`, asset names as UUID v4, slug as a mutable URL handle) were adopted as-is.

After implementation review, we'd like to revise the spec's "all IDs are UUID v7 (TEXT)" decision. The summary: switch all server-generated PKs to `INTEGER PRIMARY KEY AUTOINCREMENT`, keep a natural composite PK for OAuth identities, leave asset names as UUID v4, and treat `slug` as the URL handle it actually is rather than as an ID.

## Revised choices

| Place                         | Original spec                | Revised                                                                             | Notes                                           |
| ----------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| `users.id`                    | UUID v7, server              | `INTEGER PRIMARY KEY AUTOINCREMENT`                                                 | server-generated, never user-facing             |
| `workspaces.id`               | UUID v7, server              | `INTEGER PRIMARY KEY AUTOINCREMENT`                                                 | server-generated, internal                      |
| `documents.id`                | UUID v7, **client-provided** | `INTEGER PRIMARY KEY AUTOINCREMENT`, **server-allocated** via `POST /api/documents` | see (1) below                                   |
| OAuth identities              | n/a                          | composite `(provider, provider_id)` PK                                              | natural key; no surrogate id                    |
| Asset names (R2)              | not addressed                | UUID v4 (`crypto.randomUUID()`)                                                     | already correct; URL-exposed but not enumerable |
| `documents.slug`              | TEXT UNIQUE                  | unchanged                                                                           | mutable URL handle, not an ID                   |
| Phase 3: `document_grants.id` | (UUID v7)                    | INTEGER PK                                                                          | same reasoning                                  |
| Phase 3: `share_token`        | TEXT UNIQUE                  | unchanged; 24-byte URL-safe random                                                  | security token, not an ID                       |

## Why

**1. `documents.id` doesn't need distributed generation.** The "documents originate on-device" rationale assumed client-side allocation. The existing offline-first architecture already has an explicit local→synced split: local docs live in IDB with client-generated, locally-scoped IDs; synced docs are server-allocated; a `convertLocalDocToSynced` migration moves a local doc into the synced repo. That migration can remap IDs cleanly — the local id is consumed only by the client, the synced id comes fresh from the server. Once `documents.id` is centrally allocated, UUID's "distributed generation" benefit no longer applies, and UUID v7's "time-ordered B-tree" benefit is satisfied _better_ by INTEGER auto-increment (strictly sequential rather than mostly-sequential).

**2. `slug` makes id enumerability a non-issue for documents.** Public/external references go through `slug`. Internal `/api/documents/:id` is auth-gated, so even if integer IDs are enumerable, you can only enumerate documents you have access to. The same reasoning applies to `users.id` and `workspaces.id` — they aren't surfaced in user-facing URLs, and Phase 1 has no member-listing API that would expose other users' IDs.

**3. INTEGER PK is materially better in the chosen context.** For the spec's stated D1 write-throughput priority:

| Property               | INTEGER PK              | UUID v7 (TEXT)                 |
| ---------------------- | ----------------------- | ------------------------------ |
| Storage per id         | 4–8 bytes               | 36 chars                       |
| FK index size          | 4–8 bytes per ref       | 36 bytes per ref               |
| SQLite rowid alias     | yes (PK _is_ the rowid) | no (separate rowid + PK index) |
| Insert order on B-tree | strictly sequential     | mostly sequential              |
| Generation cost        | DB built-in             | UUID library / custom code     |

INTEGER also pays operational dividends in support tooling (`doc 42` vs `doc f1e2d3c4-…`).

**4. `slug` is mutable and therefore not an ID.** The spec listed slug as TEXT UNIQUE alongside `id`. While discussing edge cases (title updates, non-ASCII titles), it became clear that a slug is a _mutable URL handle_, not a stable identifier. The `slug TEXT UNIQUE` column stays; _how_ values are minted (random token / title-derived / nanoid) and whether they can be edited is a separate design topic for the publish flow, not schema design.

## Future-proofing: where might we regret INTEGER?

| Scenario                                                      | Likelihood | Mitigation                                                                                                                                                          |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public REST API exposes ids to third-party cachers            | medium     | Add a `public_id TEXT UNIQUE` UUID alongside the integer PK at the time the API ships. The internal PK stays INTEGER. (Stripe and GitHub both follow this pattern.) |
| Idempotent client retries want "client-supplies-id" semantics | medium     | Idempotency-key request header; no schema change                                                                                                                    |
| Cross-instance / self-hosted data merging                     | very low   | Expand–contract migration if it ever lands                                                                                                                          |
| `MAX(id)` leaks user/document count                           | low        | Not competitively sensitive for this product                                                                                                                        |
| Sharding / multi-master writes                                | very low   | D1 is single-writer per database                                                                                                                                    |

The asymmetry matters: **INTEGER → UUID is a known, bounded migration** (expand–contract). **UUID → INTEGER is harder** (no canonical mapping for historical UUID-keyed rows). Starting with INTEGER and adding a UUID-shaped _public_ id later if needed is strictly cheaper than starting with UUID and trying to slim down later.

## Net

Keep the spec's structural philosophy intact — workspaces between users and documents, OAuth in a separate table for future account-linking, slug separate from id. Just swap the PK type from `TEXT UUID v7` to `INTEGER PRIMARY KEY AUTOINCREMENT`. The schema still supports Phase 2/3 unchanged; the time-ordered-insert priority is satisfied better; storage and index sizes are smaller; debugging is easier; and the future paths that would prefer UUID are handled by a future additive `public_id` column rather than a PK migration.
