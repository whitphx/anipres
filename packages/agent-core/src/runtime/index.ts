// The runtime subpath: snapshot operations powered by the agent,
// running against a headless tldraw editor under Node. CLI and MCP
// surfaces both consume from here.
export {
  editSnapshot,
  type EditSnapshotOptions,
  type EditSnapshotResult,
  type SnapshotInput,
} from "./edit-snapshot.js";
export {
  summarizeSnapshot,
  formatSnapshotSummary,
  type SnapshotSummary,
} from "./summarize-snapshot.js";
export { installDomGlobals } from "./install-dom-globals.js";
