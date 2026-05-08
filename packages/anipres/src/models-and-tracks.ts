// Re-export the pure data-model types and helpers used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume them
// without depending on the React/UI surface in the main entry.

export type {
  Frame,
  FrameAction,
  FrameActionBase,
  FrameBase,
  FrameBatch,
  CueFrame,
  SubFrame,
  Step,
  BatchedFrames,
  ShapeAnimationFrameAction,
  CameraZoomFrameAction,
} from "./models";
export {
  cueFrameToJsonObject,
  subFrameToJsonObject,
  frameToJsonObject,
  jsonObjectToCueFrame,
  getFrame,
  getCueFrame,
  getSubFrame,
  getFrames,
  getFrameBatches,
  getNextGlobalIndexFromCueFrames,
  newTrackId,
} from "./models";
export type { OrderedTrackItem, ItemGroup } from "./ordered-track-item";
export {
  getGlobalOrder,
  reassignGlobalIndexInplace,
} from "./ordered-track-item";
