import { loadHeadlessEditor } from "anipres";
import {
  getSnapshot,
  type TLEditorSnapshot,
  type TLStoreSnapshot,
} from "tldraw";
import { applyActionStream } from "../client/apply-action-stream.js";
import { buildPromptFromEditor } from "../client/build-prompt.js";
import {
  streamActions,
  type StreamFinishInfo,
} from "../server/stream-actions.js";
import type { AgentAction } from "../schemas/agent-action.js";
import type { AgentEnv } from "../types/agent-env.js";
import { installDomGlobals } from "./install-dom-globals.js";

export type SnapshotInput = Partial<TLEditorSnapshot> | TLStoreSnapshot;

export interface EditSnapshotOptions {
  snapshot: SnapshotInput;
  /**
   * Whether the result replaces the source document rather than merging
   * into one that others may also be editing. Enables cleanup that
   * needs a whole-document view — see anipres' `soleWriter`. Defaults
   * to false.
   */
  soleWriter?: boolean;
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
  onFinish?: (info: StreamFinishInfo) => void;
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
 * Used by the CLI's edit subcommand, the MCP edit tool, and any other
 * Node-side host that wants to drive the agent against a snapshot.
 */
export async function editSnapshot(
  opts: EditSnapshotOptions,
): Promise<EditSnapshotResult> {
  // tldraw's `Editor` reaches for `document` / `HTMLElement` from
  // its constructor; under Node those globals don't exist by
  // default. Idempotent install — safe to call repeatedly.
  installDomGlobals();

  const [editor, dispose] = loadHeadlessEditor({
    snapshot: opts.snapshot,
    // The caller hands back a whole snapshot to replace the document
    // with, so this editor is its only writer for the edit's duration.
    soleWriter: opts.soleWriter ?? false,
  });
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
