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
      const result = await editSnapshot({
        snapshot: inSnapshot,
        prompt,
        env,
        modelName,
      });

      const finalPath = outputPath ?? snapshotPath;
      await writeFile(finalPath, JSON.stringify(result.snapshot, null, 2));

      const transcriptLines = result.actions.map(formatActionForLog);
      const summary = summarizeSnapshot(result.snapshot);
      const text = [
        `Wrote modified snapshot to ${finalPath}.`,
        "",
        "## Agent transcript",
        ...(transcriptLines.length > 0 ? transcriptLines : ["(no actions)"]),
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
