import { readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  editSnapshot,
  formatSnapshotSummary,
  summarizeSnapshot,
} from "@anipres/agent-cli";
import {
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  isValidModelName,
  type AgentEnv,
  type AgentModelProvider,
} from "@anipres/agent-core";
import { z } from "zod";

const REQUIRED_ENV_VAR: Record<AgentModelProvider, keyof AgentEnv> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Build an MCP server exposing two Anipres tools to coding-agent hosts
 * (Claude Code, Cursor, etc.). Both tools delegate to the same library
 * functions the CLI uses, so behaviour is identical across surfaces.
 */
export function createAnipresMcpServer(): McpServer {
  const server = new McpServer({
    name: "anipres-agent-mcp",
    version: "0.0.1",
  });

  server.registerTool(
    "anipres_summarize_snapshot",
    {
      description:
        "Inspect an Anipres snapshot file and return its presentation structure: shape counts by type, frame count, total step count, and a per-step summary of which animation tracks fire and what their actions look like. No model call, no API key required.",
      inputSchema: {
        snapshotPath: z
          .string()
          .describe(
            "Absolute or workspace-relative path to the snapshot JSON.",
          ),
      },
    },
    async ({ snapshotPath }) => {
      const raw = await readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(raw);
      const summary = summarizeSnapshot(snapshot);
      return {
        content: [
          {
            type: "text",
            text: formatSnapshotSummary(snapshotPath, summary),
          },
        ],
      };
    },
  );

  server.registerTool(
    "anipres_edit_snapshot",
    {
      description:
        "Run the Anipres agent against a snapshot file with a natural-language instruction (e.g. 'add an 8th slide framing the diagram'). The agent perceives the canvas and presentation timeline, then emits actions that create or animate shapes. Returns a transcript of the agent's reasoning plus a summary of the resulting snapshot.",
      inputSchema: {
        snapshotPath: z.string().describe("Path to the snapshot JSON to edit."),
        prompt: z
          .string()
          .describe("Natural-language instruction for the agent."),
        outputPath: z
          .string()
          .optional()
          .describe(
            "Where to write the modified snapshot. Defaults to overwriting `snapshotPath`.",
          ),
        modelName: z
          .string()
          .optional()
          .describe(
            `Model to use. Defaults to ${DEFAULT_MODEL_NAME}. The host process must have the matching env var set (ANTHROPIC_API_KEY for claude-*, OPENAI_API_KEY for gpt-*, GOOGLE_API_KEY for gemini-*).`,
          ),
      },
    },
    async ({ snapshotPath, prompt, outputPath, modelName }) => {
      const env = readEnvForModel(modelName);
      if (env instanceof Error) {
        return {
          isError: true,
          content: [{ type: "text", text: env.message }],
        };
      }

      const raw = await readFile(snapshotPath, "utf-8");
      const inSnapshot = JSON.parse(raw);
      // Capture raw chunks + finish info + stream error in-memory so we
      // can attach them to a failure response below if the run produces
      // zero actions. Cheap on success (buffer is discarded), invaluable
      // for explaining silent no-ops.
      const chunkBuffer: string[] = [];
      let finishInfo: { finishReason: string; text: string } | null = null;
      let streamError: unknown = null;
      const result = await editSnapshot({
        snapshot: inSnapshot,
        prompt,
        env,
        modelName,
        onChunk: (chunk) => chunkBuffer.push(chunk),
        onFinish: (info) => {
          finishInfo = info;
        },
        onError: (error) => {
          streamError = error;
        },
      });

      // The model is instructed to always emit at least one action — even
      // a `message` explaining a refusal. A truly empty stream means the
      // turn produced nothing useful and the caller should treat it as a
      // failure rather than a silent success.
      if (result.actions.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: explainNoActionFailure({
                streamError,
                finishInfo,
                rawText: chunkBuffer.join(""),
              }),
            },
          ],
        };
      }

      const finalPath = outputPath ?? snapshotPath;
      await writeFile(finalPath, JSON.stringify(result.snapshot, null, 2));

      const transcriptLines = result.actions.map(formatActionForLog);
      const summary = summarizeSnapshot(result.snapshot);
      const text = [
        `Wrote modified snapshot to ${finalPath}.`,
        "",
        "## Agent transcript",
        ...transcriptLines,
        "",
        "## Resulting presentation",
        formatSnapshotSummary(finalPath, summary),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

/**
 * Translate the diagnostic signals from a no-action run into a useful
 * error message. The provider-side error class is the most specific
 * thing we have — if it points at auth or rate-limiting, say so
 * directly instead of guessing at model behaviour.
 */
function explainNoActionFailure(opts: {
  streamError: unknown;
  finishInfo: { finishReason: string; text: string } | null;
  rawText: string;
}): string {
  const { streamError, finishInfo, rawText } = opts;

  if (streamError) {
    const errStr = stringifyError(streamError);
    let headline = "The agent stream errored before any actions were emitted.";
    if (/invalid x-api-key|401|unauthor/i.test(errStr)) {
      headline =
        "Authentication failed — the API key the MCP server uses is missing or invalid. " +
        "Add `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GOOGLE_API_KEY` for the chosen model) to the `env` block of the `anipres` entry in your MCP config, then reconnect the server.";
    } else if (/rate.?limit|429/i.test(errStr)) {
      headline =
        "Provider rate-limited the request. Wait a moment and retry, or switch to a different model.";
    } else if (/insufficient.?quota|credit|billing/i.test(errStr)) {
      headline =
        "Provider rejected the request for billing/quota reasons. Check the relevant provider account.";
    }
    return `${headline} Snapshot was not written.\n\nStream error:\n\`\`\`\n${errStr}\n\`\`\``;
  }

  const finishLine = finishInfo
    ? `Finish reason: \`${finishInfo.finishReason}\``
    : "Finish reason: (unknown — onFinish was not called)";
  const rawSummary = rawText
    ? `Raw model output (${rawText.length} chars):\n\`\`\`\n${rawText.slice(0, 4000)}${rawText.length > 4000 ? "\n…(truncated)" : ""}\n\`\`\``
    : "Raw model output: (empty — the model returned no text at all)";
  return `The agent emitted no actions and the stream completed without erroring. Likely a model refusal or a perception/vocabulary mismatch. Snapshot was not written.\n\n${finishLine}\n\n${rawSummary}`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\n${error.stack}` : "";
    return `${error.name}: ${error.message}${stack}`;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function readEnvForModel(modelName: string | undefined): AgentEnv | Error {
  const name = modelName ?? DEFAULT_MODEL_NAME;
  if (!isValidModelName(name)) {
    return new Error(`Unknown model: ${name}`);
  }
  const def = getAgentModelDefinition(name);
  const required = REQUIRED_ENV_VAR[def.provider];
  const value = process.env[required];
  if (!value) {
    return new Error(
      `Model "${name}" needs ${required} to be set in the host process environment.`,
    );
  }
  return { [required]: value } as AgentEnv;
}

function formatActionForLog(
  action: import("@anipres/agent-core").AgentAction,
): string {
  switch (action._type) {
    case "message":
      return `agent: ${action.text}`;
    case "think":
      return `(thinking) ${action.text}`;
    case "create":
      return `create ${action.shape._type} — ${action.intent}`;
    case "update": {
      const fields: string[] = [];
      if (action.color !== undefined) fields.push(`color=${action.color}`);
      if (action.x !== undefined) fields.push(`x=${action.x}`);
      if (action.y !== undefined) fields.push(`y=${action.y}`);
      if (action.w !== undefined) fields.push(`w=${action.w}`);
      if (action.h !== undefined) fields.push(`h=${action.h}`);
      if (action.text !== undefined)
        fields.push(`text=${JSON.stringify(action.text.slice(0, 32))}`);
      const fieldStr = fields.length > 0 ? ` { ${fields.join(", ")} }` : "";
      return `update ${action.shapeId}${fieldStr} — ${action.intent}`;
    }
    case "delete":
      return `delete ${action.shapeId} — ${action.intent}`;
    case "attachCueFrame":
      return `attachCueFrame ${action.shapeId}${action.prevShapeId ? ` (after ${action.prevShapeId})` : ""} — ${action.intent}`;
    default: {
      // Exhaustiveness check — adding a new action _type without
      // teaching the formatter will fail to typecheck.
      const _exhaustive: never = action;
      return `(unrecognised action) ${JSON.stringify(_exhaustive).slice(0, 100)}`;
    }
  }
}
