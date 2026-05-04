# TODO: Pre-Production

Tasks deferred during development that should be addressed before production release.

## Authentication

- **Merge two accounts**: When a user clicks "Connect {provider}" while logged in as User A, but the provider account is already linked to User B, the v1 implementation just shows a clear error ("This provider account is already linked to a different anipres account."). The richer behavior is to offer a merge: combine User A's and User B's documents under one user, delete the other. This is genuinely useful (real users will hit "I have two accounts and want to combine them") but it's a substantially bigger feature — it crosses the Phase 1 1:1 user↔workspace invariant (the surviving user owns two workspaces, which is Extension A territory), needs explicit confirmation UX (destructive, no undo without an undo window), and has its own race + rollback questions. Track separately.

- **Google OAuth scope for email-based linking**: Currently requests `openid` only and identifies users by `sub`. The shipped account-linking flow uses an explicit "Connect" entry point (no email matching needed), so this remains as-is. _If_ a future merge / email-based-suggest feature is added, widen to `openid email`.

## Before first deploy

Operational items the code can't cover. Each of these must be set before `wrangler deploy` (prod) or `wrangler deploy --env preview` (preview) succeeds against real Cloudflare resources.

- **D1 database ids** in `packages/worker/wrangler.toml`. Both envs ship with a placeholder (`database_id = "local"` for prod, `"preview-todo"` for preview) so wrangler fails loudly if they're forgotten. Run `wrangler d1 create anipres-db` (and `… anipres-db-preview`), then paste the returned ids in.
- **`JWT_SECRET`** secret on both envs (`wrangler secret put JWT_SECRET` and `… --env preview`). Used by `auth/session.ts` to sign / verify the cookie-session token.
- **OAuth credentials** as secrets on both envs (names match `Env` in `packages/worker/src/types.ts`):
  - `GITHUB_ID` / `GITHUB_SECRET`
  - `GOOGLE_ID` / `GOOGLE_SECRET`
- **`PUBLIC_BASE_URL` for the preview env** in `wrangler.toml`'s `[env.preview.vars]`. Production is hardcoded to `https://anipres.app`; the preview placeholder is `https://anipres-worker-preview.preview-todo.workers.dev` and needs to be replaced with the actual `workers.dev` URL after the first preview deploy. The Google OAuth callback URL the worker emits is built from this value, so a stale value here produces `redirect_uri_mismatch`.
- **OAuth redirect URIs** registered in the GitHub and Google developer consoles. The exact URIs depend on `PUBLIC_BASE_URL` for each env:
  - prod: `https://anipres.app/auth/github`, `https://anipres.app/auth/google/callback`
  - preview: `https://anipres-worker-preview.<account>.workers.dev/...`
  - local dev: `http://localhost:5173/auth/github`, `http://localhost:5173/auth/google/callback`
- **Local-dev `.dev.vars`** at `packages/worker/.dev.vars` (git-ignored). Copy `packages/worker/.dev.vars.example` to `.dev.vars` and fill in the OAuth credentials:
  ```bash
  cp packages/worker/.dev.vars.example packages/worker/.dev.vars
  $EDITOR packages/worker/.dev.vars
  ```
  Note that `PUBLIC_BASE_URL=http://localhost:5173` is required even for local dev — wrangler dev applies `wrangler.toml`'s `[vars]` to the local environment too, so without this override the worker inherits the production URL and Google rejects the OAuth redirect_uri. Restart `wrangler dev` after editing.
- **Run migrations** against both D1 instances on first deploy (and on every subsequent migration): `wrangler d1 migrations apply anipres-db` (and `… --env preview`).

## Preview architecture

- **Try migrating from A5-ii to A4 once preview has live miles**. Today: prod and preview share the same architecture (unified Worker, frontend bundled via the static-assets handler with `run_worker_first` carving out `/api/*` and `/auth/*`, served from one origin). On top of that, a per-PR Pages preview (UI smoke check, no backend) plus the shared preview Worker that bundles the latest PR's `app/dist`. A4 keeps the same shape — per-PR frontend, single shared backend — but wires the per-PR Pages frontend to talk to the shared preview Worker cross-origin instead of having the preview Worker carry its own bundled frontend. So each PR's frontend gets a working backend (auth + sync exercisable), and the latest-push-wins UI swap on the preview Worker goes away. The reason we're not on A4 today is the assumed cross-origin friction — third-party-cookie deprecation in browsers, CORS, OAuth callback proliferation, `SameSite=None` cookie footguns. Once preview is in real use, audit whether those frictions actually show up. If not, A4 is strictly cleaner.

## Post-launch hardening

See [Post-Launch Hardening](./design-server-sync.md#post-launch-hardening) in the design doc for context.

- **Cloudflare billing alerts** at 50 / 80 / 100% of paid-tier-trigger spend.
- **R2 storage growth alarm**.
- **Workers analytics dashboard review** for unusual per-route request volume.
- **Rate limiting** (Workers Rate Limiting API, per-user, applied to asset upload / snapshot push / doc create with 429 + `Retry-After`).
