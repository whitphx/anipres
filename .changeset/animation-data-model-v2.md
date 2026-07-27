---
"anipres": minor
"slidev-addon-anipres": patch
---

Animation Data Model v2 (docs/design-animation-data-model.md): animation
metadata stored in `shape.meta.frame` now uses explicit step identity
(`stepId` + fractional `stepOrderKey`) and batch membership
(`cueFrameId` + `orderKey`) instead of dense `globalIndex` integers and
`prevFrameId` linked lists. v1 documents are migrated deterministically
on load (and converted in memory on read-only paths); the derivation is
total and lossless, with structured diagnostics instead of throws.
`calculateTotalSteps` now reads snapshot JSON directly without booting a
headless editor. BREAKING for `anipres/models` consumers: the v1 helper
surface is renamed with `legacy` prefixes; the v2 model (`deriveTimeline`,
`parseFrameMeta`, `frameToMetaJson`, key helpers) is the new primary
export. For synced deployments, enforce a minimum client version before
enabling v2 writers (see `TIMELINE_FORMAT_VERSION` and the design doc's
rollout gate).
