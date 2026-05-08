// Server-only exports — safe to import from a Cloudflare Worker or any
// other runtime without pulling in tldraw or React.
export { streamActions, parseActionStream } from "./stream-actions.js";
export type {
  StreamActionsOptions,
  StreamFinishInfo,
} from "./stream-actions.js";
export { buildSystemPrompt } from "./build-system-prompt.js";
export { buildMessages } from "./build-messages.js";
export { closeAndParseJson } from "./close-and-parse-json.js";
export { getModel } from "./providers.js";

// Re-export the things route handlers always need so they don't have to
// reach across into the top-level barrel (which pulls in client utils).
export {
  AGENT_MODEL_DEFINITIONS,
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  isValidModelName,
  type AgentModelDefinition,
  type AgentModelName,
  type AgentModelProvider,
} from "../models.js";
export type { Streaming } from "../types/streaming.js";
export type { AgentEnv } from "../types/agent-env.js";
export type { AgentAction } from "../schemas/agent-action.js";
export { parseAgentPrompt } from "../schemas/prompt-part.js";
export type {
  AgentPrompt,
  ModePart,
  ParseAgentPromptResult,
} from "../schemas/prompt-part.js";
