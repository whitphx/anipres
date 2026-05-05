import { readFile, writeFile } from "node:fs/promises";
import {
  applyActionStream,
  getPartUtil,
  getRegisteredActionTypes,
  getRegisteredPartTypes,
  makeDefaultModePart,
  makeUserMessagesPart,
  streamActions,
  type AgentAction,
  type AgentPrompt,
} from "@anipres/agent-core";
import { loadHeadlessEditor } from "anipres";
import { getSnapshot } from "tldraw";

export interface EditCommandOptions {
  inputPath: string;
  outputPath: string;
  prompt: string;
  env: import("@anipres/agent-core").AgentEnv;
  modelName?: string;
}

export async function runEditCommand(opts: EditCommandOptions): Promise<void> {
  const raw = await readFile(opts.inputPath, "utf-8");
  const snapshot = JSON.parse(raw);

  const [editor, dispose] = loadHeadlessEditor({ snapshot });

  try {
    const prompt = buildPrompt(editor, opts.prompt);

    const stream = streamActions({
      prompt,
      env: opts.env,
      modelName: opts.modelName,
    });

    await applyActionStream({
      editor,
      actions: stream,
      onComplete: (action) => printActionForUser(action),
    });

    const out = getSnapshot(editor.store);
    await writeFile(opts.outputPath, JSON.stringify(out, null, 2));
  } finally {
    dispose();
  }
}

function buildPrompt(
  editor: import("tldraw").Editor,
  userMessage: string,
): AgentPrompt {
  const actionTypes = getRegisteredActionTypes();
  const partTypes = getRegisteredPartTypes();
  const mode = makeDefaultModePart({ actionTypes, partTypes });

  const prompt: Record<string, unknown> = { mode };
  prompt.userMessages = makeUserMessagesPart([userMessage]);

  for (const partType of partTypes) {
    const util = getPartUtil(partType);
    if (!util) continue;
    const part = util.getPart({ editor });
    if (!part) continue;
    prompt[part.type] = part;
  }

  return prompt as AgentPrompt;
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
