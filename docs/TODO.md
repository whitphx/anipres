# TODO: Pre-Production

Tasks deferred during development that should be addressed before production release.

## Authentication

- **Account linking**: Allow users to connect multiple OAuth providers (GitHub + Google) to a single account. Requires a `user_providers` junction table and an explicit "connect account" flow in settings. See design discussion in the Phase 3 implementation. When implementing this, review the `user:email` scope comment and related design in `packages/worker/src/worker.ts` — email-based linking may make that scope intentionally required rather than a library workaround.

- **Google OAuth scope for account linking**: Currently requests `openid` only and identifies users by `sub`. If account linking is implemented via email, the scope will need to be widened to `openid email`.

## Phases Not Yet Implemented

- **Phase 6 — Anonymous mode + polish**: Online/offline indicator, reconnection UX, user profile/settings, rate limiting, input validation.

## Convert-to-synced polish

Follow-ups deferred from the convert-to-synced PRs (#431–#435). None are blocking; group here so they surface during a Phase 6 polish pass.

- **Friendly error-message mapping**: `conversionError.message` flows directly to the button's `title` / `aria-label` today, surfacing strings like `"Asset upload failed: 413"` or `"signal timed out"`. Map to user-friendly text (413 → "This file is too large", `AbortError` → "Upload timed out — check your connection and try again", other 4xx/5xx → "Couldn't reach the server. Try again.").
- **`aria-live` region for screen readers**: Convert state changes only announce when the button is re-focused. A `<div aria-live="polite">` near the sidebar footer would announce success/failure passively. Needs a small design pass on when/what to announce.
- **Asset-upload concurrency cap**: `uploadAssetDataUrls` runs every data-URL asset upload in parallel via `Promise.all`. A legacy doc with many inline images will fire N simultaneous requests. Add a small pool (4–6 in flight) to be kinder to the browser connection pool and the worker.
- **Tighten internal `composeWithTimeout` / default-helper signatures**: The internal `composeWithTimeout(userSignal?: AbortSignal)` helper and the `abortSignal?: AbortSignal` params on `defaultUploadAsset` / `defaultPushSnapshot` read like they can be called without an argument, but every call site passes the value. Change those internals to `AbortSignal | undefined` for an honest signature. The public `ConvertLocalDocToSyncedParams` interface keeps `?` for consumer ergonomics.
