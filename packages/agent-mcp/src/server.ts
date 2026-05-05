import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  editSnapshot,
  formatSnapshotSummary,
  summarizeSnapshot,
} from "@anipres/agent-cli";

// When set, raw model text-stream output is appended to this file for
// diagnosing silent no-op runs. Off by default — enable by exporting
// `ANIPRES_AGENT_DEBUG_LOG=/tmp/foo.log` in the MCP host's env block.
const DEBUG_LOG = process.env.ANIPRES_AGENT_DEBUG_LOG;
function debugLog(line: string): void {
  if (!DEBUG_LOG) return;
  try {
    appendFileSync(DEBUG_LOG, line);
  } catch {
    // Best-effort — don't let logging failures break the tool.
  }
}
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
      debugLog(
        `\n=== ${new Date().toISOString()} edit ${snapshotPath} ===\nPROMPT: ${prompt}\nMODEL: ${modelName ?? "(default)"}\n--- raw model output ---\n`,
      );
      // Always capture raw chunks + finish info in-memory so we can
      // attach them to a failure response below if the run produces
      // zero actions. Cheap; removes the need for host-side env-var
      // configuration to diagnose silent no-ops.
      const chunkBuffer: string[] = [];
      let finishInfo: { finishReason: string; text: string } | null = null;
      const result = await editSnapshot({
        snapshot: inSnapshot,
        prompt,
        env,
        modelName,
        onChunk: (chunk) => {
          debugLog(chunk);
          chunkBuffer.push(chunk);
        },
        onFinish: (info) => {
          finishInfo = info;
          debugLog(`\n[finishReason=${info.finishReason}]\n`);
        },
      });
      debugLog(
        `\n--- end stream; ${result.actions.length} action(s) parsed ---\n`,
      );

      // The model is instructed to always emit at least one action — even
      // a `message` explaining a refusal. A truly empty stream means the
      // turn produced nothing useful and the caller should treat it as a
      // failure rather than a silent success.
      if (result.actions.length === 0) {
        const rawJoined = chunkBuffer.join("");
        const rawSummary = rawJoined
          ? `Raw model output (${rawJoined.length} chars):\n\`\`\`\n${rawJoined.slice(0, 4000)}${rawJoined.length > 4000 ? "\n…(truncated)" : ""}\n\`\`\``
          : "Raw model output: (empty — the model returned no text at all)";
        const finishLine = finishInfo
          ? `Finish reason: \`${(finishInfo as { finishReason: string }).finishReason}\``
          : "Finish reason: (unknown — onFinish was not called)";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `The agent emitted no actions for this prompt — likely a model refusal or a perception/vocabulary mismatch. Snapshot was not written.\n\n${finishLine}\n\n${rawSummary}`,
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
    case "attachCueFrame":
      return `attachCueFrame ${action.shapeId}${action.prevShapeId ? ` (after ${action.prevShapeId})` : ""} — ${action.intent}`;
  }
}
