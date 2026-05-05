export type AgentModelProvider = "anthropic" | "openai" | "google";

export interface AgentModelDefinition {
  name: string;
  id: string;
  provider: AgentModelProvider;
  /** Provider-specific hint that this model benefits from extra thinking
   *  budget (e.g. Gemini reasoning models). */
  thinking?: boolean;
}

/**
 * The agent's model registry. Adding a model is a one-line change here;
 * the provider switch in `providers.ts` does the rest. Model ids must
 * match the provider's own naming.
 */
export const AGENT_MODEL_DEFINITIONS = {
  // Anthropic
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
  "claude-haiku-4-5": {
    name: "claude-haiku-4-5",
    id: "claude-haiku-4-5",
    provider: "anthropic",
  },

  // OpenAI
  "gpt-5": {
    name: "gpt-5",
    id: "gpt-5",
    provider: "openai",
  },
  "gpt-4o": {
    name: "gpt-4o",
    id: "gpt-4o",
    provider: "openai",
  },

  // Google
  "gemini-2.5-pro": {
    name: "gemini-2.5-pro",
    id: "gemini-2.5-pro",
    provider: "google",
    thinking: true,
  },
  "gemini-2.5-flash": {
    name: "gemini-2.5-flash",
    id: "gemini-2.5-flash",
    provider: "google",
  },
} as const satisfies Record<string, AgentModelDefinition>;

export type AgentModelName = keyof typeof AGENT_MODEL_DEFINITIONS;

export const DEFAULT_MODEL_NAME: AgentModelName = "claude-sonnet-4-5";

export function isValidModelName(
  value: string | undefined,
): value is AgentModelName {
  // Object.hasOwn (not `in`) so untrusted input like "constructor" or
  // "__proto__" doesn't pass via Object.prototype lookup. With plain
  // `in`, those keys would also resolve to truthy values from
  // bracket-access (e.g. `defs["constructor"] === Object`), bypassing
  // the `!def` guard in getAgentModelDefinition and crashing later
  // when downstream code reads `.provider`.
  return !!value && Object.hasOwn(AGENT_MODEL_DEFINITIONS, value);
}

export function getAgentModelDefinition(
  modelName: AgentModelName,
): AgentModelDefinition {
  const def = AGENT_MODEL_DEFINITIONS[modelName];
  if (!def) throw new Error(`Model ${modelName} not found`);
  return def;
}
