// Re-export the pure data-model surface used by the presentation
// engine — split out so external tools (e.g. the agent CLI) can consume
// it without depending on the React/UI surface in the main entry.

export * from "./timeline-model";

export { SYNC_CLIENT_VERSION } from "./sync-client-version";
export { newTrackId } from "./models";
export { timelineShapesOfEditor } from "./media/live-media-events";
// Pure record work, so it lives on the entry a tool can load without
// pulling in React or a DOM.
export { convertLegacyVideoIdentityInSnapshot } from "./media/normalize-video-identity";
