// Re-export the pure data-model types and helpers used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume them
// without depending on the React/UI surface in the main entry.
//
// As of Animation Data Model v2 (docs/design-animation-data-model.md) this
// entry exposes the v2 model (timeline-model). The v1 helpers remain
// available from here for migration-era consumers, prefixed `legacy`.

export * from "./timeline-model";

// --- Legacy v1 surface (deprecated; retained for migration-era tooling).
export type {
  Frame as LegacyModelFrame,
  CueFrame as LegacyModelCueFrame,
  SubFrame as LegacyModelSubFrame,
  FrameBatch as LegacyFrameBatch,
  Step as LegacyStep,
  BatchedFrames as LegacyBatchedFrames,
} from "./models";
export {
  cueFrameToJsonObject as legacyCueFrameToJsonObject,
  subFrameToJsonObject as legacySubFrameToJsonObject,
  frameToJsonObject as legacyFrameToJsonObject,
  getFrame as getLegacyFrame,
  getCueFrame as getLegacyCueFrame,
  getSubFrame as getLegacySubFrame,
  getFrames as getLegacyFrames,
  getFrameBatches as getLegacyFrameBatches,
  newTrackId,
} from "./models";
// NOTE: `ordered-track-item` (getGlobalOrder, OrderedTrackItem, ItemGroup)
// is internal-only as of v2 — the v1 ordering pipeline is kept solely for
// the legacy types above; order derivation goes through `deriveTimeline`.
