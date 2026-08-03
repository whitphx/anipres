---
"anipres": minor
---

Remove the v1 animation-data migration machinery. Versions 0.14.x convert v1 (`globalIndex`/`prevFrameId`) documents to the v2 model on load; from this version on, v1 data is no longer converted and instead surfaces as a `v1-frame` diagnostic in the Timeline, with a "Delete animation data" resolution. To keep a v1 document, open and save it once under anipres 0.14.x before upgrading.

Breaking API changes (versioned as a minor per the 0.x convention): the migration surface is gone from the main entry (`migrateV1Frames`, `V1_STEP_PREFIX`, `makeMigratedStepId`, `parseMigratedStepId`, `getMigratedStepOrderKey`), the deprecated `legacy*` v1 model surface is gone from `anipres/models`, and `deriveTimeline` no longer takes a `pageId` input. Persisted `v1step:`-prefixed step ids produced by the migration remain valid opaque step ids.
