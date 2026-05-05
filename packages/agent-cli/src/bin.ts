#!/usr/bin/env node
import "./setup-dom.js";

import { parseArgs } from "node:util";
import {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  isValidModelName,
  type AgentEnv,
  type AgentModelProvider,
} from "@anipres/agent-core";
import { runEditCommand } from "./edit-command.js";
import { runSummarizeCommand } from "./summarize-command.js";

const MODEL_LIST = Object.keys(AGENT_MODEL_DEFINITIONS).join(", ");

const REQUIRED_ENV_VAR: Record<AgentModelProvider, keyof AgentEnv> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

const USAGE = `Usage:
  anipres-agent edit <snapshot.json> --prompt "<message>" [options]
  anipres-agent summarize <snapshot.json>

The "edit" subcommand sends the snapshot plus your prompt to the agent
and writes the modified snapshot back. "summarize" loads a snapshot and
prints its presentation structure (no LLM call, no API key required).

Edit options:
  --prompt, -p <text>   Required. The instruction to send to the agent.
  --out, -o <path>      Where to write the modified snapshot. Defaults to overwriting <snapshot.json>.
  --model, -m <name>    Model to use (default: ${DEFAULT_MODEL_NAME}).
                        Available: ${MODEL_LIST}
  --help, -h            Show this message.

Environment (the one matching the chosen model's provider must be set):
  ANTHROPIC_API_KEY     For claude-* models.
  OPENAI_API_KEY        For gpt-* models.
  GOOGLE_API_KEY        For gemini-* models.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const subcommand = argv[0];
  if (subcommand === "summarize") {
    const inputPath = argv[1];
    if (!inputPath) {
      process.stderr.write("Missing snapshot path.\n\n" + USAGE);
      return 2;
    }
    await runSummarizeCommand(inputPath);
    return 0;
  }

  if (subcommand !== "edit") {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  // IIFE keeps the narrowed parseArgs return type (preserves
  // `values.prompt: string | undefined` rather than collapsing to the
  // union of all option shapes) while letting us catch the throw and
  // exit cleanly. Bad flag → usage error (exit 2), not a stack trace.
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          prompt: { type: "string", short: "p" },
          out: { type: "string", short: "o" },
          model: { type: "string", short: "m" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n\n${USAGE}`);
      return null;
    }
  })();
  if (!parsed) return 2;
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const inputPath = positionals[0];
  if (!inputPath) {
    process.stderr.write("Missing snapshot path.\n\n" + USAGE);
    return 2;
  }
  if (!values.prompt) {
    process.stderr.write("Missing --prompt.\n\n" + USAGE);
    return 2;
  }

  const modelName = values.model ?? DEFAULT_MODEL_NAME;
  if (!isValidModelName(modelName)) {
    process.stderr.write(
      `Unknown model "${modelName}". Available: ${MODEL_LIST}\n`,
    );
    return 2;
  }
  const def = getAgentModelDefinition(modelName);

  const env: AgentEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  const required = REQUIRED_ENV_VAR[def.provider];
  if (!env[required]) {
    process.stderr.write(
      `Model "${modelName}" needs ${required}. Set it in your environment and re-run.\n`,
    );
    return 2;
  }

  await runEditCommand({
    inputPath,
    outputPath: values.out ?? inputPath,
    prompt: values.prompt,
    env,
    modelName,
  });

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  },
);
