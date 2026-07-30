---
"anipres": major
"anipres-worker": minor
"slidev-addon-anipres": patch
"@anipres/agent-core": patch
"app": patch
---

Animation Data Model v2 (docs/design-animation-data-model.md): animation
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
`x-anipres-animation-data-version` header). v1 clients send neither and
are rejected with HTTP 426 after deployment — reload to pick up the new
client. The gate constant is derived from the library's
`TIMELINE_FORMAT_VERSION`.

DEPLOY ORDER: deploy the app (clients that declare the version) BEFORE
or together with the worker gate — a worker-first deploy cuts off every
running client. Tabs still running the previous bundle when the gate
lands lose sync (the WebSocket upgrade exposes no HTTP status, so the
426 surfaces as a connection error); the app shows a "reload to
continue" screen on sync-connection errors and a version-specific
message on rejected snapshot pushes.

Also fixes the app's document-list ordering: `sortOrder` values are
fractional index keys, and comparing them with `localeCompare`
mis-sorts entries keyed before the first item (capital-prefixed keys)
and varies with the viewer's locale. All fractional-key comparisons now
go through the library's code-unit `compareOrderKeys`.
