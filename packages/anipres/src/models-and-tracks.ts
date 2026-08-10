// Re-export the pure data-model surface used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume
// it without depending on the React/UI surface in the main entry.

export * from "./timeline-model";

export { SYNC_CLIENT_VERSION } from "./sync-client-version";
export { newTrackId } from "./models";
export { timelineShapesOf } from "./media/live-media-events";
