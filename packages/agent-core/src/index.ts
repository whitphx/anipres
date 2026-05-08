// Convenient barrel for callers that don't care about the server/client
// split. The CLI, the web app, and the worker can all import from this entry.
// Bundlers will tree-shake the unused half.

export * from "./types/streaming.js";
export * from "./types/agent-env.js";
export * from "./models.js";
export * from "./format/focused-color.js";
export * from "./format/focused-easing.js";
export * from "./format/focused-frame-action.js";
export * from "./format/focused-shape.js";
export * from "./schemas/agent-action.js";
export * from "./schemas/prompt-part.js";
export * from "./schemas/build-response-schema.js";
export * from "./server/index.js";
export * from "./client/index.js";
