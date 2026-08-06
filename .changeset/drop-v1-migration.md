---
"anipres": minor
"slidev-addon-anipres": patch
---

Remove the v1 animation-data migration machinery. Versions 0.14.x convert v1 (`globalIndex`/`prevFrameId`) documents to the v2 model on load; from this version on, v1 data is no longer converted and instead surfaces as a `v1-frame` diagnostic in the Timeline, with a "Delete animation data" resolution. To preserve a v1 document's animation data, open and save it once under anipres 0.14.x before upgrading.

Breaking API changes (versioned as a minor per the 0.x convention): the migration surface is gone from both entry points (`migrateV1Frames`, `V1_STEP_PREFIX`, `makeMigratedStepId`, `parseMigratedStepId`, `getMigratedStepOrderKey`, and the `MigrationResult` / `MigrationDiagnostic` / `ShapeLegacyFrame` / `ShapeV2Frame` types); `anipres/models` additionally loses the deprecated v1 model surface (the `LegacyModel*` / `LegacyFrameBatch` / `LegacyStep` / `LegacyBatchedFrames` types and the `legacy*` / `getLegacy*` helpers), while the v1 parse types (`LegacyFrame`, `LegacyCueFrame`, `LegacySubFrame`) stay, since v1 data is still recognized; `deriveTimeline` no longer takes a `pageId` input; and `TimelineDiagnostic` gains a `v1-frame` member, which is source-breaking for exhaustive switches. Persisted `v1step:`-prefixed step ids produced by the migration remain valid opaque step ids.
