# TODO: Pre-Production

Tasks deferred during development that should be addressed before production release.

## Authentication

- **Account linking**: Allow users to connect multiple OAuth providers (GitHub + Google) to a single account. Requires a `user_providers` junction table and an explicit "connect account" flow in settings. See design discussion in the Phase 3 implementation. When implementing this, review the `user:email` scope comment and related design in `packages/worker/src/worker.ts` — email-based linking may make that scope intentionally required rather than a library workaround.

- **Google OAuth scope for account linking**: Currently requests `openid` only and identifies users by `sub`. If account linking is implemented via email, the scope will need to be widened to `openid email`.

## Phases Not Yet Implemented

- **Phase 4 — Local-to-cloud asset migration**: R2 asset storage and remote `TLAssetStore` are implemented. Remaining: migrate inline data-URL assets from local IDB snapshots to R2 on first login/sync.
- **Phase 4.x — Persist synced document snapshots on the server**: `DocumentSyncRoom` still keeps the live tldraw room state in memory only. Persisting/restoring the server snapshot would let asset reconciliation trust `getCurrentSnapshot()` even after the last socket disconnects, instead of relying on current stopgap behavior around stale uploaded assets.
- **Phase 5 — Offline support + IDB cache**: Debounced IDB cache in synced mode, offline fallback, push-or-fork reconnection logic.
- **Phase 6 — Anonymous mode + polish**: Online/offline indicator, reconnection UX, user profile/settings, rate limiting, input validation.
