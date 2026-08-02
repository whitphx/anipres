// Re-export the pure data-model surface used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume
// it without depending on the React/UI surface in the main entry.
//
// This is the v2 model (timeline-model). The v1 helper surface lived
// here until the one-time v1 -> v2 batch migration ran and the
// migration machinery was removed (design doc r9).

export * from "./timeline-model";

export { newTrackId } from "./models";
