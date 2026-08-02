---
"anipres": major
"@anipres/agent-core": patch
---

Remove the one-time v1 -> v2 migration machinery. All known v1
documents were batch-converted in a verified pass (the deployment is
sole-user), so the concurrent-migration support - `migrateV1Frames`,
the `v1step:` id parse contract (`V1_STEP_PREFIX`,
`makeMigratedStepId`, `parseMigratedStepId`), the migration key
functions (`getMigratedStepOrderKey`), mixed-document read conversion
inside `deriveTimeline`, and the mount-time migration - is deleted.

BREAKING (`anipres`): the exports above are gone; `deriveTimeline` no
longer takes a `pageId` (it existed only for migration coordinates);
the legacy v1 model surface (`LegacyModel*` types, `legacy*`
serializers, `getLegacy*` getters, `getNextGlobalIndexFromCueFrames`)
is removed from `anipres/models`. v1 frames still parse (recognition
only) and now surface as a `v1-frame` timeline diagnostic instead of
converting; previously persisted `v1step:`-prefixed step ids remain
valid opaque `stepId`s.
