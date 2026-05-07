// Side-effect: install happy-dom globals before tldraw is touched.
// Tldraw's headless `Editor` reaches for `document` during construction,
// so this has to run before `tldraw` and `anipres` are imported below.
// Co-located here (rather than in entry points) so any consumer that
// pulls in `editSnapshot` gets the setup automatically.
import "./setup-dom.js";

import { readFile, writeFile } from "node:fs/promises";
import {
  applyActionStream,
  buildPromptFromEditor,
  streamActions,
  type AgentAction,
  type AgentEnv,
} from "@anipres/agent-core";
import { loadHeadlessEditor } from "anipres";
import {
  getSnapshot,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from "tldraw";

export type SnapshotInput = Partial<TLEditorSnapshot> | TLStoreSnapshot;

export interface EditSnapshotOptions {
  snapshot: SnapshotInput;
  prompt: string;
  env: AgentEnv;
  modelName?: string;
  /** Called for each completed action — `message`/`think` text or
   *  `create`/`attachCueFrame` summaries. Defaults to a no-op. */
  onAction?: (action: AgentAction) => void;
  /** Diagnostic hook: called for every raw text chunk the model emits,
   *  before the JSON parser sees it. Useful for capturing model output
   *  when the parser yields nothing. */
  onChunk?: (chunk: string) => void;
  /** Diagnostic hook: called once after the model stream finishes with
   *  the provider's finish reason and joined text. Useful for
   *  explaining silent no-ops. */
  onFinish?: (info: import("@anipres/agent-core").StreamFinishInfo) => void;
  /** Diagnostic hook: called when the AI SDK reports a stream-level
   *  error (some of which it swallows instead of throwing). */
  onError?: (error: unknown) => void;
  /** Aborts the upstream model call. The MCP server wires this from the
   *  per-request signal so a cancelled tool invocation doesn't keep
   *  draining the provider stream and burning the user's API quota. */
  abortSignal?: AbortSignal;
}

export interface EditSnapshotResult {
  snapshot: TLEditorSnapshot;
  /** All completed actions, in the order they arrived. */
  actions: AgentAction[];
}

/**
 * Pure(-ish) function: load a snapshot, run the agent against it, and
 * return the modified snapshot plus the action transcript. No file I/O.
 * Used by both the CLI's edit subcommand and the MCP edit tool.
 */
export async function editSnapshot(
  opts: EditSnapshotOptions,
): Promise<EditSnapshotResult> {
  const [editor, dispose] = loadHeadlessEditor({ snapshot: opts.snapshot });

  const transcript: AgentAction[] = [];

  try {
    const prompt = buildPromptFromEditor(editor, opts.prompt);

    const stream = streamActions({
      prompt,
      env: opts.env,
      modelName: opts.modelName,
      abortSignal: opts.abortSignal,
      onChunk: opts.onChunk,
      onFinish: opts.onFinish,
      onError: opts.onError,
    });

    await applyActionStream({
      editor,
      actions: stream,
      onComplete: (action) => {
        transcript.push(action);
        opts.onAction?.(action);
      },
    });

    return { snapshot: getSnapshot(editor.store), actions: transcript };
  } finally {
    dispose();
  }
}

export interface EditCommandOptions {
  inputPath: string;
  outputPath: string;
  prompt: string;
  env: AgentEnv;
  modelName?: string;
}

export async function runEditCommand(opts: EditCommandOptions): Promise<void> {
  const raw = await readFile(opts.inputPath, "utf-8");
  const snapshot = JSON.parse(raw);

  const result = await editSnapshot({
    snapshot,
    prompt: opts.prompt,
    env: opts.env,
    modelName: opts.modelName,
    onAction: printActionForUser,
  });

  await writeFile(opts.outputPath, JSON.stringify(result.snapshot, null, 2));
}

function printActionForUser(action: AgentAction): void {
  switch (action._type) {
    case "message":
      process.stdout.write(`\n${action.text}\n`);
      break;
    case "think":
      process.stderr.write(`[thinking] ${action.text}\n`);
      break;
    case "create":
      process.stderr.write(
        `[create] ${action.intent} (${action.shape._type})\n`,
      );
      break;
    case "attachCueFrame":
      process.stderr.write(
        `[cue] ${action.intent} (shape=${action.shapeId}, action=${action.action.type})\n`,
      );
      break;
  }
}
