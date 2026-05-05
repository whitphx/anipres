#!/usr/bin/env node
import "./setup-dom.js";

import { parseArgs } from "node:util";
import {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  isValidModelName,
  type AgentEnv,
} from "@anipres/agent-core";
import { runEditCommand } from "./edit-command.js";

const MODEL_LIST = Object.keys(AGENT_MODEL_DEFINITIONS).join(", ");

const USAGE = `Usage: anipres-agent edit <snapshot.json> --prompt "<message>" [options]

Options:
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
  if (subcommand !== "edit") {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      out: { type: "string", short: "o" },
      model: { type: "string", short: "m" },
      help: { type: "boolean", short: "h" },
    },
  });

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

const REQUIRED_ENV_VAR: Record<
  ReturnType<typeof getAgentModelDefinition>["provider"],
  keyof AgentEnv
> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

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
