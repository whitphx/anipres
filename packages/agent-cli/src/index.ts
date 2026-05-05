// Library entry. Consumers (e.g. `@anipres/agent-mcp`) import the pure
// `editSnapshot` / `summarizeSnapshot` functions from here. The CLI's
// `bin.ts` keeps using the same functions internally — there's no
// command-only logic that isn't also useful as a library API.
//
// Importing this module also installs the DOM polyfills tldraw needs to
// run headlessly under Node, via the side-effect import below.
import "./setup-dom.js";

export {
  editSnapshot,
  runEditCommand,
  type EditSnapshotOptions,
  type EditSnapshotResult,
  type EditCommandOptions,
} from "./edit-command.js";
export {
  summarizeSnapshot,
  formatSnapshotSummary,
  runSummarizeCommand,
  type SnapshotSummary,
} from "./summarize-command.js";
