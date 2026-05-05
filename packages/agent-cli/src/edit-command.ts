import { readFile, writeFile } from "node:fs/promises";
import {
  applyActionStream,
  buildPromptFromEditor,
  streamActions,
  type AgentAction,
  type AgentEnv,
} from "@anipres/agent-core";
import { loadHeadlessEditor } from "anipres";
import { getSnapshot } from "tldraw";

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

  const [editor, dispose] = loadHeadlessEditor({ snapshot });

  try {
    const prompt = buildPromptFromEditor(editor, opts.prompt);

    const stream = streamActions({
      prompt,
      env: opts.env,
      modelName: opts.modelName,
    });

    await applyActionStream({
      editor,
      actions: stream,
      onComplete: printActionForUser,
    });

    const out = getSnapshot(editor.store);
    await writeFile(opts.outputPath, JSON.stringify(out, null, 2));
  } finally {
    dispose();
  }
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
