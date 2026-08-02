// Re-export the pure data-model surface used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume
// it without depending on the React/UI surface in the main entry.

export * from "./timeline-model";

export { newTrackId } from "./models";
