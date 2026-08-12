# anipres

## 0.17.0

### Minor Changes

- [#513](https://github.com/whitphx/anipres/pull/513) [`8ab0a90`](https://github.com/whitphx/anipres/commit/8ab0a907fce77578107b15b6b10405b356fc7d3d) Thanks [@whitphx](https://github.com/whitphx)! - Let a video move and resize across presentation steps.

  A video shape no longer mounts a player. Shapes render a poster and the runtime owns exactly one live player per video, positioned to follow whichever carrier currently represents it, so a copy of a video is harmless and its keyframes become ordinary copies — the follow-up-frame buttons, drag & drop, duplicate-remap and paste all apply to videos unchanged. Videos also stop being exempt from the latest-frame-of-batch visibility rule.

  Carriers of one video are tied together by a `videoKey` in their `meta` rather than by the `media-control` binding, which a media event now names directly; a video's shared settings resolve per property by revision stamp, so concurrent edits converge.

  The shared-room arbitration for deleting a video's last carrier is designed but not built, so removing the event markers of a deleted video runs only where the client is the document's sole writer; in a synced document those markers are left in place rather than risking their loss to a concurrent edit. A media event whose video has no carrier left is dropped by the timeline derivation either way, so a deleted video leaves no empty steps behind wherever its markers linger, and a carrier of that video returning brings its events back. Carrying a video's settings onto the surviving carriers is not gated that way and runs wherever a carrier is deleted, since deleting the carrier whose revisions won a setting would otherwise drop the video back to a stale carrier's older value.

  **Deploy note.** `SYNC_CLIENT_VERSION` moves to 4: an older client has no notion of a video that moves, mounts a player per carrier and keeps them all visible, so a moving video comes up as several independent players.

  The `media-control` binding that the unreleased embed feature used to record which video an event controls is removed outright, type and all, rather than converted: it never reached a release, so no published version can have written one. A document that does hold one, from a build of `main` between the two changes, will not load.

- [#500](https://github.com/whitphx/anipres/pull/500) [`bcbe2e0`](https://github.com/whitphx/anipres/commit/bcbe2e05673e983876a974c1cd0ad67b949db208) Thanks [@whitphx](https://github.com/whitphx)! - Add YouTube video embedding with timeline-driven playback control: a new `youtube-embed` shape carries a video and renders its poster, the live YouTube IFrame Player being held by the runtime and positioned over whichever shape currently represents that video, and `mediaControl` animation frames (play, pause, stop, mute, unmute, setVolume) — carried by `media-control` marker shapes that name the video — fire as the presentation advances. Step jumps and backward navigation reconcile each player to the state implied by the event history, so playback stays deterministic.

  The sync version gate now keys on a new `SYNC_CLIENT_VERSION` (exported from `anipres/models`), raised to 3 for the `youtube-embed` and `media-control` records and the `mediaControl` frame action. `TIMELINE_FORMAT_VERSION` stays 2: the shape of a frame record is unchanged. The gate matches this version exactly rather than treating it as a floor: a client below it cannot read the records a document may hold, and a client above it would write records the worker has no schema registration for, which the room would reject on save.

  This release is one-way: once a document holds a `youtube-embed` or `media-control` record, a worker without those schema registrations cannot load its room. Roll forward rather than back, and keep the registrations in any release that follows. Deploy ordering is not a concern — the worker serves the app bundle and both ship from one build — but a tab left open across the deploy still runs the previous bundle and is refused by the gate until it reloads. The agent's `presentationState` prompt part also changes shape (per-frame actions instead of one action per batch); the server accepts the previous form and normalizes it, so an older tab's agent requests don't fail with a 400.

### Patch Changes

- [#515](https://github.com/whitphx/anipres/pull/515) [`2150fe6`](https://github.com/whitphx/anipres/commit/2150fe648e1ca56dc4ae1ad2d19f14f3437a90a2) Thanks [@whitphx](https://github.com/whitphx)! - Lock a YouTube embed's aspect ratio while resizing. The embedded player is letterboxed inside whatever box the shape is given, so a shape reshaped away from the video's own ratio grew bars rather than picture, and the handles moved without the video following them.

  Order a video's own movement ahead of its media events where both fall in the same step of its timeline row. A step's batches run concurrently, so which of the two reads first carries no meaning and cannot be dragged into a different one; left to the derivation it came out in frame-id order, which is to say arbitrarily, and differently for every video.

## 0.16.0

### Minor Changes

- [#508](https://github.com/whitphx/anipres/pull/508) [`69cec97`](https://github.com/whitphx/anipres/commit/69cec97eb037d0dc454f9264afe6801e6cf5eeec) Thanks [@whitphx](https://github.com/whitphx)! - Label timeline steps from 0 instead of 1. The number now counts advances: step N is where the presentation lands after N "next" actions, so step 0 is the un-advanced state. Under the old labels the first column read "1" while standing at zero advances, so every number was one ahead of the presses needed to reach it.

  The agent's perception of the timeline and its system prompt described steps from 1 to match the old labels, and now use the same numbering, so a message like "I added a slide as step 7" points at the column the user sees. The step button also gains `type="button"`, an `aria-label` (the visible text is a bare digit) and `aria-current`.

## 0.15.1

### Patch Changes

- [#503](https://github.com/whitphx/anipres/pull/503) [`30d6150`](https://github.com/whitphx/anipres/commit/30d6150e93887677d0126a7c3cf9a9b922f0d0bc) Thanks [@whitphx](https://github.com/whitphx)! - Keep the editor alive across re-renders: `getShapeVisibility` is part of tldraw's editor-creation dependency list, so the previously inline callback made every re-render of `Anipres` dispose and recreate the `Editor` — on a synced store, every WebSocket reconnect did this, clearing undo history and remounting the canvas mid-presentation.

## 0.15.0

### Minor Changes

- [#490](https://github.com/whitphx/anipres/pull/490) [`00b743a`](https://github.com/whitphx/anipres/commit/00b743acec21adea7b6004889da3e6d97345067f) Thanks [@whitphx](https://github.com/whitphx)! - Remove the v1 animation-data migration machinery. Versions 0.14.x convert v1 (`globalIndex`/`prevFrameId`) documents to the v2 model on load; from this version on, v1 data is no longer converted and instead surfaces as a `v1-frame` diagnostic in the Timeline, with a "Delete animation data" resolution. To preserve a v1 document's animation data, open and save it once under anipres 0.14.x before upgrading.

  Breaking API changes (versioned as a minor per the 0.x convention): the migration surface is gone from both entry points (`migrateV1Frames`, `V1_STEP_PREFIX`, `makeMigratedStepId`, `parseMigratedStepId`, `getMigratedStepOrderKey`, and the `MigrationResult` / `MigrationDiagnostic` / `ShapeLegacyFrame` / `ShapeV2Frame` types); `anipres/models` additionally loses the deprecated v1 model surface (the `LegacyModel*` / `LegacyFrameBatch` / `LegacyStep` / `LegacyBatchedFrames` types and the `legacy*` / `getLegacy*` helpers), while the v1 parse types (`LegacyFrame`, `LegacyCueFrame`, `LegacySubFrame`) stay, since v1 data is still recognized; `deriveTimeline` no longer takes a `pageId` input; and `TimelineDiagnostic` gains a `v1-frame` member, which is source-breaking for exhaustive switches. Persisted `v1step:`-prefixed step ids produced by the migration remain valid opaque step ids.

## 0.14.0

### Minor Changes

- [#486](https://github.com/whitphx/anipres/pull/486) [`3c2ef77`](https://github.com/whitphx/anipres/commit/3c2ef776f580aac7554f5831276a831f80c04312) Thanks [@whitphx](https://github.com/whitphx)! - Animation Data Model v2 (docs/design-animation-data-model.md): animation
  metadata stored in `shape.meta.frame` now uses explicit step identity
  (`stepId` + fractional `stepOrderKey`) and batch membership
  (`cueFrameId` + `orderKey`) instead of dense `globalIndex` integers and
  `prevFrameId` linked lists. v1 documents are migrated deterministically
  on load (and converted in memory on read-only paths); the derivation is
  total and lossless, with structured diagnostics instead of throws.
  `calculateTotalSteps` now reads snapshot JSON directly without booting a
  headless editor.

  BREAKING (`anipres`): the `anipres/models` v1 helper surface is renamed
  with `legacy` prefixes, and the v1 ordering primitives (`getGlobalOrder`,
  `OrderedTrackItem`, `ItemGroup`) are removed from the public surface
  entirely (internal-only). The v2 model (`deriveTimeline`,
  `parseFrameMeta`, `frameToMetaJson`, key helpers) is the new primary
  export.

  The sync server now enforces the animation-data version gate: sync
  connections and snapshot uploads must declare
  `animationDataVersion >= 2` (query param or
  `x-anipres-animation-data-version` header). v1 clients send neither: a
  sync connection is rejected in-protocol (see DEPLOY ORDER below) and a
  snapshot upload with HTTP 426 — reload to pick up the new client. The
  gate constant is derived from the library's `TIMELINE_FORMAT_VERSION`.

  DEPLOY ORDER: deploy the app (clients that declare the version) BEFORE
  or together with the worker gate — a worker-first deploy cuts off every
  running client. A stale sync connection is rejected IN-PROTOCOL: the
  worker accepts the upgrade and closes the socket with tldraw's
  sync-error close code and `CLIENT_TOO_OLD` (an HTTP status before the
  upgrade would surface as an opaque 1006 the client retries forever), so
  `useSync` reports an error state and the app shows a reason-specific
  screen — "outdated version, reload" for `CLIENT_TOO_OLD`, accurate copy
  for `NOT_FOUND`/`FORBIDDEN`/`NOT_AUTHENTICATED`. Every
  snapshot-replacement flow (local-to-synced migration, offline
  reconnect, stale-version retry, offline-copy fork) declares the version
  through one shared client helper; a rejected push (HTTP 426) surfaces
  as an explicit client-too-old result with a reload path instead of a
  generic failure.

  New worker endpoint `DELETE /api/documents/:id/initialization`: cancels
  a document its creating client abandoned before finalizing (the regular
  DELETE route deliberately 404s initializing rows). The
  cancellation-vs-snapshot race is decided atomically inside the
  document's Durable Object, on the same serialized task queue as
  snapshot pushes: if a snapshot has landed, cancellation is refused
  (mirroring the initialization sweep's "genuinely abandoned" test);
  otherwise a persisted reservation makes any later push to that id fail
  with 404 instead of writing into a room whose D1 row is being deleted —
  so no interleaving can destroy pushed content or orphan a pushed
  snapshot. The snapshot-push route also verifies its finalizing D1
  update actually landed and reports 404 when the row vanished
  mid-flight. The offline-reconnect fork flow uses the endpoint to clean
  up a fork whose snapshot push failed; if the cancellation itself fails,
  the invisible row is left for the sweep.

  Also fixes the app's document-list ordering: `sortOrder` values are
  fractional index keys, and comparing them with `localeCompare`
  mis-sorts entries keyed before the first item (capital-prefixed keys)
  and varies with the viewer's locale. All fractional-key comparisons now
  go through the library's code-unit `compareOrderKeys`.

## 0.13.0

### Minor Changes

- [#409](https://github.com/whitphx/anipres/pull/409) [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09) Thanks [@whitphx](https://github.com/whitphx)! - ESM-only — drop the CJS build.

  The package now ships only an ESM build. The `./schema` subpath was already ESM-only (no `require` branch in `exports`) since it was added; consolidating the main entry to match.

  Drops from `package.json`:
  - `main` field (was the `.cjs` artifact)
  - `module` field (redundant now that `exports` is the single source)
  - The `require` branch in `exports."."`

  The `vite.config.ts` lib config now pins `formats: ["es"]` so vite stops emitting `.cjs` outputs alongside the ESM ones.

  This is a breaking change for consumers using `require("anipres")` from a CJS context. ESM consumers (the dominant pattern in modern React tooling — Vite, Next.js 13+, Webpack 5+, Cloudflare Workers, etc.) are unaffected. Internal consumers in this repo (`packages/app` via Vite, `packages/worker` via workerd) already use ESM.

- [#409](https://github.com/whitphx/anipres/pull/409) [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09) Thanks [@whitphx](https://github.com/whitphx)! - Three cleanups from PR review.

  **`<Anipres>` accepts a `maxAssetSize` prop.** Previously the component hardcoded a 10 MB cap derived from a `MAX_ASSET_SIZE` constant exported from `anipres/schema`. Asset-size policy is a deployment concern (the consumer needs to keep client and server in sync), not a UI-library concern, so the constant has been removed from `anipres` and the limit is now passed in by the caller. If you don't supply `maxAssetSize`, the editor inherits tldraw's built-in default.

  **`anipres/schema` no longer exports `MAX_ASSET_SIZE`.** Consumers that imported it should host it in their own deployment-policy module — for example, this repo moved it to `packages/worker` (the canonical source for server-side enforcement) and exposes it via the worker's `exports["./asset-policy"]` so the app can import the same value.

  **`anipres/schema` now also exports the shape types**: `SlideShape`, `ThemeImageShape`, `ThemeImageShapeProps`, `ThemeDimension` — useful for non-React consumers that need to type their snapshot data, alongside the existing runtime exports (`slideShapeProps`, `SlideShapeType`, `themeImageShapeProps`, `ThemeImageShapeType`).

  **Internal cleanup**: the pattern `<Tldraw {...(store ? { store } : { snapshot })}>` was replaced with `<Tldraw store={store} snapshot={snapshot}>`. tldraw's discriminated-union types handle the resolution; the parent now passes both props transparently and tldraw decides which initialization path to use.

- [#409](https://github.com/whitphx/anipres/pull/409) [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09) Thanks [@whitphx](https://github.com/whitphx)! - Expose anipres' shape building blocks for advanced consumers:
  - The `anipres/schema` subpath now also exports `slideShapeProps`, `SlideShapeType`, `themeImageShapeProps`, and `ThemeImageShapeType` — pure-TS values usable outside React (e.g. validating snapshots on a server).
  - The main entry now exports `customShapeUtils`, `allShapeUtils`, and `allBindingUtils` for embedders that build a tldraw editor with anipres' shapes plus their own.

### Patch Changes

- [#409](https://github.com/whitphx/anipres/pull/409) [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09) Thanks [@whitphx](https://github.com/whitphx)! - Tighten the `tldraw` peer dependency from `^3.15.5` to exact `3.15.5`. Anipres' shape schemas are now shared across the editor and the new `anipres/schema` subpath; minor tldraw versions can change shape internals, so pinning keeps the contract stable. Consumers should align their own `tldraw` install to the same exact version.

## 0.12.1

### Patch Changes

- [#405](https://github.com/whitphx/anipres/pull/405) [`486a0b5`](https://github.com/whitphx/anipres/commit/486a0b5f0f32d6b5638e4bfbf383bb6e715c9804) Thanks [@whitphx](https://github.com/whitphx)! - Extract SlideShape types and props into a separate pure-TS file to match the ThemeImageShape pattern

## 0.12.0

### Minor Changes

- [#396](https://github.com/whitphx/anipres/pull/396) [`3237021`](https://github.com/whitphx/anipres/commit/3237021199163d475028eb0f8f53bfad7f956cac) Thanks [@whitphx](https://github.com/whitphx)! - Add `colorScheme` prop to Anipres component for per-instance color scheme control via TLUser

## 0.11.1

### Patch Changes

- [#393](https://github.com/whitphx/anipres/pull/393) [`c9e2dbe`](https://github.com/whitphx/anipres/commit/c9e2dbec057ab6f9f5d979696cd0c7325adde0eb) Thanks [@whitphx](https://github.com/whitphx)! - Fix ThemeImage copy-paste not transferring both assets when pasting to another document

## 0.11.0

### Minor Changes

- [#382](https://github.com/whitphx/anipres/pull/382) [`d8e624a`](https://github.com/whitphx/anipres/commit/d8e624a45af1978a12c95db2d0d656e795f96878) Thanks [@whitphx](https://github.com/whitphx)! - Sync dimensions on ThemeImage between themes

### Patch Changes

- [#383](https://github.com/whitphx/anipres/pull/383) [`3c2ff70`](https://github.com/whitphx/anipres/commit/3c2ff70ff5976722b82e8bc380513b7bf639638f) Thanks [@whitphx](https://github.com/whitphx)! - Fix a bug where ThemeImage.crop is reset when resizing

## 0.10.1

### Patch Changes

- [#379](https://github.com/whitphx/anipres/pull/379) [`996fea5`](https://github.com/whitphx/anipres/commit/996fea55a2cae35ee63ef4cd4c01cf5c4b560378) Thanks [@whitphx](https://github.com/whitphx)! - Internal refactoring to extract crop comparison helper

## 0.10.0

### Minor Changes

- [#375](https://github.com/whitphx/anipres/pull/375) [`a58ac69`](https://github.com/whitphx/anipres/commit/a58ac697451c4a16bc08015a0519a0d1577c48e4) Thanks [@whitphx](https://github.com/whitphx)! - Add ThemeImage shape

## 0.9.3

### Patch Changes

- [#365](https://github.com/whitphx/anipres/pull/365) [`5bdd2ed`](https://github.com/whitphx/anipres/commit/5bdd2ed4008fba452cc9b49b3d2c223696ae80c0) Thanks [@whitphx](https://github.com/whitphx)! - Refactoring to memoize DnD component

- [#363](https://github.com/whitphx/anipres/pull/363) [`17ee022`](https://github.com/whitphx/anipres/commit/17ee022ff2ba7c4a99348b85edf057ec63bca385) Thanks [@whitphx](https://github.com/whitphx)! - Refactoring to handle dom mount events

- [#369](https://github.com/whitphx/anipres/pull/369) [`49a0c4b`](https://github.com/whitphx/anipres/commit/49a0c4bd8085b7bbd4aae63318957dabf822d9b6) Thanks [@whitphx](https://github.com/whitphx)! - Very rough styling on the add-cue-frame button on a group

## 0.9.2

### Patch Changes

- [#360](https://github.com/whitphx/anipres/pull/360) [`78a149f`](https://github.com/whitphx/anipres/commit/78a149fc5b79a2da81cb29c55d67fc9601e99909) Thanks [@whitphx](https://github.com/whitphx)! - Internal refactoring on ref usage

## 0.9.1

### Patch Changes

- [#354](https://github.com/whitphx/anipres/pull/354) [`a266506`](https://github.com/whitphx/anipres/commit/a26650643137b1a6392b5f85fa016f028acd71c0) Thanks [@whitphx](https://github.com/whitphx)! - Internal refactoring not to use ref to manage the PresentationManager instance

## 0.9.0

### Minor Changes

- [#216](https://github.com/whitphx/anipres/pull/216) [`789122c`](https://github.com/whitphx/anipres/commit/789122c20088e394ac3f7d54d6fb7cc9f2f5ad9e) Thanks [@whitphx](https://github.com/whitphx)! - Handle group shapes

- [#351](https://github.com/whitphx/anipres/pull/351) [`7bdba0a`](https://github.com/whitphx/anipres/commit/7bdba0a2635f5d15c0fd392d720a7348aaa2f24e) Thanks [@whitphx](https://github.com/whitphx)! - Deselect shapes when entering the presentation mode

## 0.8.1

### Patch Changes

- [#330](https://github.com/whitphx/anipres/pull/330) [`15551e2`](https://github.com/whitphx/anipres/commit/15551e27727ac322eda2acaab4a18e64c0604f88) Thanks [@whitphx](https://github.com/whitphx)! - Deselect edit tools when enabling presentation mode

- [#329](https://github.com/whitphx/anipres/pull/329) [`799af5a`](https://github.com/whitphx/anipres/commit/799af5a9d0502d2a3dbf80bb13c1e4800caca036) Thanks [@whitphx](https://github.com/whitphx)! - Refactoring PresentationManager structure

## 0.8.0

### Minor Changes

- [#306](https://github.com/whitphx/anipres/pull/306) [`e97a6ea`](https://github.com/whitphx/anipres/commit/e97a6ea62eb0594060666f3e4ed66568ca55bfa8) Thanks [@whitphx](https://github.com/whitphx)! - Expose calculateTotalSteps() API

- [#321](https://github.com/whitphx/anipres/pull/321) [`e3e5bf6`](https://github.com/whitphx/anipres/commit/e3e5bf6e21848d2dcd6500773bce1c3827848fc5) Thanks [@whitphx](https://github.com/whitphx)! - Expose moveTo() instead of signals via onMount()

### Patch Changes

- [#327](https://github.com/whitphx/anipres/pull/327) [`62d997b`](https://github.com/whitphx/anipres/commit/62d997b7c7073f45267e1bec47261f35de05b650) Thanks [@whitphx](https://github.com/whitphx)! - Fix internal logic object initialization and handling so that getShapeVisibility works as expected

- [#321](https://github.com/whitphx/anipres/pull/321) [`e3e5bf6`](https://github.com/whitphx/anipres/commit/e3e5bf6e21848d2dcd6500773bce1c3827848fc5) Thanks [@whitphx](https://github.com/whitphx)! - Fix animation frame timing to avoid flickering

## 0.7.2

### Patch Changes

- [#317](https://github.com/whitphx/anipres/pull/317) [`afaf5b8`](https://github.com/whitphx/anipres/commit/afaf5b86ec41746294d6a34b8bd86a9bf4b28c2a) Thanks [@whitphx](https://github.com/whitphx)! - Set visibility of shapes that are children of a group shape so that they are properly animated

## 0.7.1

### Patch Changes

- [#307](https://github.com/whitphx/anipres/pull/307) [`8f9ac54`](https://github.com/whitphx/anipres/commit/8f9ac541e61b8fc363cb4a6d66b0ed373aef2942) Thanks [@whitphx](https://github.com/whitphx)! - Stop using deprecated isShapeHidden and replace it with getShapeVisibility

## 0.7.0

### Minor Changes

- [#305](https://github.com/whitphx/anipres/pull/305) [`3d538c7`](https://github.com/whitphx/anipres/commit/3d538c753773b93df2523663d565c57bcd431d71) Thanks [@whitphx](https://github.com/whitphx)! - Set inline code style

### Patch Changes

- [#303](https://github.com/whitphx/anipres/pull/303) [`56cc658`](https://github.com/whitphx/anipres/commit/56cc658ff5bd24ec27bfcb4683df3323765a46e2) Thanks [@whitphx](https://github.com/whitphx)! - Update Tldraw to 3.15.5

## 0.6.6

### Patch Changes

- [#288](https://github.com/whitphx/anipres/pull/288) [`686660a`](https://github.com/whitphx/anipres/commit/686660a266c4da3836fff4cd8ee6648ba635fe63) Thanks [@whitphx](https://github.com/whitphx)! - Update dependencies

## 0.6.5

### Patch Changes

- [#268](https://github.com/whitphx/anipres/pull/268) [`18e6820`](https://github.com/whitphx/anipres/commit/18e6820d5a5e9047291c0b750e7e4bbd769e94ec) Thanks [@whitphx](https://github.com/whitphx)! - NPM trusted publishing

## 0.6.4

### Patch Changes

- [#245](https://github.com/whitphx/anipres/pull/245) [`785e711`](https://github.com/whitphx/anipres/commit/785e711b26553eb9f1aa3cb99c37d36e3b244606) Thanks [@whitphx](https://github.com/whitphx)! - Add repository field to package.json"

## 0.6.3

### Patch Changes

- [#242](https://github.com/whitphx/anipres/pull/242) [`666aa55`](https://github.com/whitphx/anipres/commit/666aa55422c1ea4d1e9da8d800c84bf42db8781e) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release as the previous version failed

## 0.6.2

### Patch Changes

- [#237](https://github.com/whitphx/anipres/pull/237) [`71a736d`](https://github.com/whitphx/anipres/commit/71a736da43a33bfd7901a4051d3f6be681f82db9) Thanks [@whitphx](https://github.com/whitphx)! - Add provenance

## 0.6.1

### Patch Changes

- [#223](https://github.com/whitphx/anipres/pull/223) [`c48e741`](https://github.com/whitphx/anipres/commit/c48e7418cde949451da2b09db3f61af2286fefd0) Thanks [@whitphx](https://github.com/whitphx)! - Refactoring

## 0.6.0

### Minor Changes

- [#219](https://github.com/whitphx/anipres/pull/219) [`6ea0a66`](https://github.com/whitphx/anipres/commit/6ea0a66d308f79d0756976ff61ddafdecad9d807) Thanks [@whitphx](https://github.com/whitphx)! - Stop running the step when entering the presentatio mode

- [#219](https://github.com/whitphx/anipres/pull/219) [`6ea0a66`](https://github.com/whitphx/anipres/commit/6ea0a66d308f79d0756976ff61ddafdecad9d807) Thanks [@whitphx](https://github.com/whitphx)! - Delete the start prop, and trigger runStep() reacting to the $currentStepIndex signal

### Patch Changes

- [#219](https://github.com/whitphx/anipres/pull/219) [`6ea0a66`](https://github.com/whitphx/anipres/commit/6ea0a66d308f79d0756976ff61ddafdecad9d807) Thanks [@whitphx](https://github.com/whitphx)! - Internal refactoring of the way to manage the signals depending on the editor object

## 0.5.2

### Patch Changes

- [#217](https://github.com/whitphx/anipres/pull/217) [`2578c87`](https://github.com/whitphx/anipres/commit/2578c87517f7d275a65a4b9bd01376afde79edb4) Thanks [@whitphx](https://github.com/whitphx)! - Set a less vivid color to the frame icons for higher contrast with the selection borders"

## 0.5.1

### Patch Changes

- [#173](https://github.com/whitphx/anipres/pull/173) [`57cf65a`](https://github.com/whitphx/anipres/commit/57cf65a6a063e5d682f27b17a873046d07cbfdb3) Thanks [@whitphx](https://github.com/whitphx)! - Fix styling of a dragged frame editor element

## 0.5.0

### Minor Changes

- [#157](https://github.com/whitphx/anipres/pull/157) [`9292c1b`](https://github.com/whitphx/anipres/commit/9292c1bc4a9de8cb0acaae1bb44b59a7805758fe) Thanks [@whitphx](https://github.com/whitphx)! - Prevent the undo/redo stack from adding new records during animation

## 0.4.0

### Minor Changes

- [#151](https://github.com/whitphx/anipres/pull/151) [`9e652d3`](https://github.com/whitphx/anipres/commit/9e652d3978f2d0f6c4da11ceca53a67f48e772a9) Thanks [@whitphx](https://github.com/whitphx)! - Allow entering edit state on embed shapes in presentation mode

## 0.3.0

### Minor Changes

- [#148](https://github.com/whitphx/anipres/pull/148) [`149eeec`](https://github.com/whitphx/anipres/commit/149eeece8873bf1b228c9260b92b1bcb87f076fa) Thanks [@whitphx](https://github.com/whitphx)! - Improve the presentation mode impl to allow interacting with embed widgets

## 0.2.0

### Minor Changes

- [#143](https://github.com/whitphx/anipres/pull/143) [`090ecf2`](https://github.com/whitphx/anipres/commit/090ecf21c2e66cb67b88ad32391ba0b83060aa90) Thanks [@whitphx](https://github.com/whitphx)! - Add timestamp to each track so that the tracks are sorted in the created time order

## 0.1.1

### Patch Changes

- [#140](https://github.com/whitphx/anipres/pull/140) [`39cfc12`](https://github.com/whitphx/anipres/commit/39cfc125c88192dfeecd8622236d0f5c0cc221e7) Thanks [@whitphx](https://github.com/whitphx)! - Prevent click events on <DragOverlay /> from being propagated to document.body, which unexpectedly exits the edit mode of Slidev addon

## 0.1.0

### Minor Changes

- [#124](https://github.com/whitphx/anipres/pull/124) [`0c8565f`](https://github.com/whitphx/anipres/commit/0c8565fb8c9fa597c236c78c8fd7278d1dfeddf0) Thanks [@whitphx](https://github.com/whitphx)! - Mount the dragged element as a portal so that it works in Slidev addon

## 0.0.12

### Patch Changes

- [#108](https://github.com/whitphx/anipres/pull/108) [`59b2f88`](https://github.com/whitphx/anipres/commit/59b2f88c87fe129ba53b2285c2b40641b01f7652) Thanks [@whitphx](https://github.com/whitphx)! - Limit the timeline UI height

## 0.0.11

### Patch Changes

- [#90](https://github.com/whitphx/anipres/pull/90) [`6a5cd3a`](https://github.com/whitphx/anipres/commit/6a5cd3a288999adbf4240f92a8aeb4d441d233ab) Thanks [@whitphx](https://github.com/whitphx)! - Font customization option

## 0.0.10

### Patch Changes

- [`9361f96`](https://github.com/whitphx/anipres/commit/9361f9616f77924343d262d27fdf528988794187) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

- [#76](https://github.com/whitphx/anipres/pull/76) [`7a23c77`](https://github.com/whitphx/anipres/commit/7a23c77a70556fe5e8e0632a7b7153e0cc632fa1) Thanks [@whitphx](https://github.com/whitphx)! - Refactoring: make `<ControlPanel />`'s interface simpler

## 0.0.9

### Patch Changes

- [`67800f8`](https://github.com/whitphx/anipres/commit/67800f8da220b9e92380007a5f328ca64377cdcf) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.8

### Patch Changes

- [`1c70295`](https://github.com/whitphx/anipres/commit/1c702953f278e9cfe65d5b767df826c129cf49cb) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.7

### Patch Changes

- [`5604d18`](https://github.com/whitphx/anipres/commit/5604d18fefd13fe78d07128286dc44868e8ae807) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.6

### Patch Changes

- [`69bfdc8`](https://github.com/whitphx/anipres/commit/69bfdc8c54d349c07d8ccc57378637770a3c1bab) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.5

### Patch Changes

- [`b40a7e4`](https://github.com/whitphx/anipres/commit/b40a7e4e243deb64628422c2bb4c3367d06e9535) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.4

### Patch Changes

- [`9c7a6e2`](https://github.com/whitphx/anipres/commit/9c7a6e2ad235b7b092592dcbd6cbbbe38123f18c) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.3

### Patch Changes

- [`17fda9f`](https://github.com/whitphx/anipres/commit/17fda9ffb9d2067dcb54293887011cd69a719a30) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.2

### Patch Changes

- [`19468d0`](https://github.com/whitphx/anipres/commit/19468d0a4ebe60b9035be2ca84621e460f302921) Thanks [@whitphx](https://github.com/whitphx)! - Trigger release

## 0.0.1

### Patch Changes

- [`e5c72b3`](https://github.com/whitphx/anipres/commit/e5c72b334c11248618f1329f84291d86e4787cf9) Thanks [@whitphx](https://github.com/whitphx)! - Init release
