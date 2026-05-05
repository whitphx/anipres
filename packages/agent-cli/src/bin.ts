#!/usr/bin/env node
import "./setup-dom.js";

import { parseArgs } from "node:util";
import { runEditCommand } from "./edit-command.js";

const USAGE = `Usage: anipres-agent edit <snapshot.json> --prompt "<message>" [options]

Options:
  --prompt, -p <text>      Required. The instruction to send to the agent.
  --out, -o <path>         Where to write the modified snapshot. Defaults to overwriting <snapshot.json>.
  --model, -m <name>       Model to use (default: claude-sonnet-4-5).
  --api-key <key>          Anthropic API key. Defaults to $ANTHROPIC_API_KEY.
  --help, -h               Show this message.

Environment:
  ANTHROPIC_API_KEY        Used if --api-key is not supplied.
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
      "api-key": { type: "string" },
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

  const apiKey = values["api-key"] ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "No API key provided. Set ANTHROPIC_API_KEY or pass --api-key.\n",
    );
    return 2;
  }

  await runEditCommand({
    inputPath,
    outputPath: values.out ?? inputPath,
    prompt: values.prompt,
    apiKey,
    modelName: values.model,
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
