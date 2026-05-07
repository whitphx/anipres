// Library entry. Consumers (e.g. `@anipres/agent-mcp`) import the pure
// `editSnapshot` / `summarizeSnapshot` functions from here. The CLI's
// `bin.ts` keeps using the same functions internally — there's no
// command-only logic that isn't also useful as a library API.
//
// The DOM polyfills tldraw needs at headless runtime are installed by
// `edit-command.ts` and `summarize-command.ts` themselves (their
// top-of-file `import "./setup-dom.js"`), so any consumer that pulls
// in either function gets the setup automatically — no manual
// ordering at the entry point required.

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
