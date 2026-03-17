# TODO: Pre-Production

Tasks deferred during development that should be addressed before production release.

## Authentication

- **Account linking**: Allow users to connect multiple OAuth providers (GitHub + Google) to a single account. Requires a `user_providers` junction table and an explicit "connect account" flow in settings. See design discussion in the Phase 3 implementation. When implementing this, review the `user:email` scope comment and related design in `packages/worker/src/worker.ts` — email-based linking may make that scope intentionally required rather than a library workaround.

- **Narrow Google OAuth scope**: Currently requests `openid email profile` but only uses `sub` (the OpenID subject identifier). Should be narrowed to `openid` only — unless account linking uses email, in which case the scope decision should be revisited.

## Phases Not Yet Implemented

- **Phase 4 — Local-to-cloud asset migration**: R2 asset storage and remote `TLAssetStore` are implemented. Remaining: migrate inline data-URL assets from local IDB snapshots to R2 on first login/sync.
- **Phase 5 — Offline support + IDB cache**: Debounced IDB cache in synced mode, offline fallback, push-or-fork reconnection logic.
- **Phase 6 — Anonymous mode + polish**: Online/offline indicator, reconnection UX, user profile/settings, rate limiting, input validation.
