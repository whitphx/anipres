import { readFile, writeFile } from "node:fs/promises";
import { editSnapshot } from "@anipres/agent-core/runtime";
import type { AgentAction, AgentEnv } from "@anipres/agent-core";

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
