export type AgentModelProvider = "anthropic" | "openai" | "google";

export interface AgentModelDefinition {
  name: string;
  id: string;
  provider: AgentModelProvider;
  thinking?: boolean;
}

export const AGENT_MODEL_DEFINITIONS = {
  "claude-sonnet-4-5": {
    name: "claude-sonnet-4-5",
    id: "claude-sonnet-4-5",
    provider: "anthropic",
  },
  "claude-opus-4-5": {
    name: "claude-opus-4-5",
    id: "claude-opus-4-5",
    provider: "anthropic",
  },
} as const satisfies Record<string, AgentModelDefinition>;

export type AgentModelName = keyof typeof AGENT_MODEL_DEFINITIONS;

export const DEFAULT_MODEL_NAME: AgentModelName = "claude-sonnet-4-5";

export function isValidModelName(
  value: string | undefined,
): value is AgentModelName {
  return !!value && value in AGENT_MODEL_DEFINITIONS;
}

export function getAgentModelDefinition(
  modelName: AgentModelName,
): AgentModelDefinition {
  const def = AGENT_MODEL_DEFINITIONS[modelName];
  if (!def) throw new Error(`Model ${modelName} not found`);
  return def;
}
