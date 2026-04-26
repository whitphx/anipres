# TODO: Pre-Production

Tasks deferred during development that should be addressed before production release.

## Authentication

- **Account linking**: Allow users to connect multiple OAuth providers (GitHub + Google) to a single account. Requires a `user_providers` junction table and an explicit "connect account" flow in settings. See design discussion in the Phase 3 implementation. When implementing this, review the `user:email` scope comment and related design in `packages/worker/src/worker.ts` — email-based linking may make that scope intentionally required rather than a library workaround.

- **Google OAuth scope for account linking**: Currently requests `openid` only and identifies users by `sub`. If account linking is implemented via email, the scope will need to be widened to `openid email`.

## Phases Not Yet Implemented

- **Phase 6 — Anonymous mode + polish**: User profile/settings (the current minimal "logged in as X / logout" surface in the sidebar footer is sufficient for now). Online/offline indicator, reconnection UX, and input validation are done.

## Preview architecture

- **Try migrating from A5-ii to A4 once preview has live miles**. Today: prod and preview share the same architecture (unified Worker, frontend bundled via the static-assets handler with `run_worker_first` carving out `/api/*` and `/auth/*`, served from one origin). On top of that, a per-PR Pages preview (UI smoke check, no backend) plus the shared preview Worker that bundles the latest PR's `app/dist`. A4 keeps the same shape — per-PR frontend, single shared backend — but wires the per-PR Pages frontend to talk to the shared preview Worker cross-origin instead of having the preview Worker carry its own bundled frontend. So each PR's frontend gets a working backend (auth + sync exercisable), and the latest-push-wins UI swap on the preview Worker goes away. The reason we're not on A4 today is the assumed cross-origin friction — third-party-cookie deprecation in browsers, CORS, OAuth callback proliferation, `SameSite=None` cookie footguns. Once preview is in real use, audit whether those frictions actually show up. If not, A4 is strictly cleaner.

## Post-launch hardening

See [Post-Launch Hardening](./design-server-sync.md#post-launch-hardening) in the design doc for context.

- **Cloudflare billing alerts** at 50 / 80 / 100% of paid-tier-trigger spend.
- **R2 storage growth alarm**.
- **Workers analytics dashboard review** for unusual per-route request volume.
- **Rate limiting** (Workers Rate Limiting API, per-user, applied to asset upload / snapshot push / doc create with 429 + `Retry-After`).

## Convert-to-synced polish

Follow-ups deferred from the convert-to-synced PRs (#431–#435). None are blocking; group here so they surface during a Phase 6 polish pass.

- **Friendly error-message mapping**: `conversionError.message` flows directly to the button's `title` / `aria-label` today, surfacing strings like `"Asset upload failed: 413"` or `"signal timed out"`. Map to user-friendly text (413 → "This file is too large", `AbortError` → "Upload timed out — check your connection and try again", other 4xx/5xx → "Couldn't reach the server. Try again.").
- **`aria-live` region for screen readers**: Convert state changes only announce when the button is re-focused. A `<div aria-live="polite">` near the sidebar footer would announce success/failure passively. Needs a small design pass on when/what to announce.
- **Asset-upload concurrency cap**: `uploadAssetDataUrls` runs every data-URL asset upload in parallel via `Promise.all`. A legacy doc with many inline images will fire N simultaneous requests. Add a small pool (4–6 in flight) to be kinder to the browser connection pool and the worker.
- **Tighten internal `composeWithTimeout` / default-helper signatures**: The internal `composeWithTimeout(userSignal?: AbortSignal)` helper and the `abortSignal?: AbortSignal` params on `defaultUploadAsset` / `defaultPushSnapshot` read like they can be called without an argument, but every call site passes the value. Change those internals to `AbortSignal | undefined` for an honest signature. The public `ConvertLocalDocToSyncedParams` interface keeps `?` for consumer ergonomics.
