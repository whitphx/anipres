# anipres-worker

## 0.1.3

### Patch Changes

- Updated dependencies [[`69cec97`](https://github.com/whitphx/anipres/commit/69cec97eb037d0dc454f9264afe6801e6cf5eeec)]:
  - anipres@0.16.0
  - @anipres/agent-core@0.0.6

## 0.1.2

### Patch Changes

- Updated dependencies [[`30d6150`](https://github.com/whitphx/anipres/commit/30d6150e93887677d0126a7c3cf9a9b922f0d0bc)]:
  - anipres@0.15.1
  - @anipres/agent-core@0.0.5

## 0.1.1

### Patch Changes

- Updated dependencies [[`00b743a`](https://github.com/whitphx/anipres/commit/00b743acec21adea7b6004889da3e6d97345067f)]:
  - anipres@0.15.0
  - @anipres/agent-core@0.0.4

## 0.1.0

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

### Patch Changes

- Updated dependencies [[`3c2ef77`](https://github.com/whitphx/anipres/commit/3c2ef776f580aac7554f5831276a831f80c04312)]:
  - anipres@0.14.0
  - @anipres/agent-core@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [[`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09), [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09), [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09), [`ba8fb42`](https://github.com/whitphx/anipres/commit/ba8fb42f034efabd82556d1db860c8ca12040f09)]:
  - anipres@0.13.0
  - @anipres/agent-core@0.0.2
