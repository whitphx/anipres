#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
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
import { runConvertCommand } from "./convert-command.js";

const MODEL_LIST = Object.keys(AGENT_MODEL_DEFINITIONS).join(", ");

const REQUIRED_ENV_VAR: Record<AgentModelProvider, keyof AgentEnv> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

const editCommand = defineCommand({
  meta: {
    name: "edit",
    description:
      "Send a snapshot plus a natural-language prompt to the agent and write the modified snapshot back. The matching provider's API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY) must be set in the environment.",
  },
  args: {
    snapshot: {
      type: "positional",
      description: "Path to the snapshot JSON to edit.",
      required: true,
    },
    prompt: {
      type: "string",
      alias: "p",
      description: "Instruction for the agent.",
      required: true,
    },
    out: {
      type: "string",
      alias: "o",
      description:
        "Where to write the modified snapshot. Defaults to overwriting the input.",
    },
    model: {
      type: "string",
      alias: "m",
      default: DEFAULT_MODEL_NAME,
      description: `Model to use. Available: ${MODEL_LIST}.`,
    },
  },
  async run({ args }) {
    const { snapshot, prompt, out, model: modelName } = args;
    // Known input-validation errors exit 2 directly rather than
    // throwing — citty would otherwise print a stack trace, which
    // is noise for "you typed the wrong thing" cases. Truly
    // unexpected runtime errors (network failures, provider 5xx)
    // bubble out of runEditCommand and citty handles them.
    if (!isValidModelName(modelName)) {
      process.stderr.write(
        `Unknown model "${modelName}". Available: ${MODEL_LIST}\n`,
      );
      process.exit(2);
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
      process.exit(2);
    }

    await runEditCommand({
      inputPath: snapshot,
      outputPath: out ?? snapshot,
      prompt,
      env,
      modelName,
    });
  },
});

const summarizeCommand = defineCommand({
  meta: {
    name: "summarize",
    description:
      "Load a snapshot and print its presentation structure (shape counts by type, frame count, per-step summary). No LLM call, no API key required.",
  },
  args: {
    snapshot: {
      type: "positional",
      description: "Path to the snapshot JSON to summarize.",
      required: true,
    },
  },
  async run({ args }) {
    await runSummarizeCommand(args.snapshot);
  },
});

const convertCommand = defineCommand({
  meta: {
    name: "convert",
    description:
      "Bring a snapshot up to the current media vocabulary: media events name their video directly, and the `media-control` bindings a document written before that are removed. Idempotent, and no LLM call or API key is needed.",
  },
  args: {
    snapshot: {
      type: "positional",
      description: "Path to the snapshot JSON to convert.",
      required: true,
    },
    out: {
      type: "string",
      alias: "o",
      description:
        "Where to write the converted snapshot. Defaults to overwriting the input.",
    },
  },
  async run({ args }) {
    await runConvertCommand(args.snapshot, args.out ?? args.snapshot);
  },
});

const main = defineCommand({
  meta: {
    name: "anipres-agent",
    description:
      "Anipres CLI for the agent feature. Edit a snapshot with natural language, or print its presentation structure.",
  },
  subCommands: {
    edit: editCommand,
    summarize: summarizeCommand,
    convert: convertCommand,
  },
});

// Force-exit on success. The headless-tldraw / anipres imports
// register process-level handles (timers from transitive deps,
// happy-dom workers from `installDomGlobals`) that the Node event
// loop won't drain on its own; without this the process would
// print its output then hang. citty already handles error exits.
runMain(main).then(() => process.exit(0));
