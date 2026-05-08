export type AgentModelProvider = "anthropic" | "openai" | "google";

export interface AgentModelDefinition {
  name: string;
  id: string;
  provider: AgentModelProvider;
  /** Provider-specific hint that this model benefits from extra thinking
   *  budget (e.g. Gemini reasoning models). */
  thinking?: boolean;
  /** This model is a reasoning model that rejects the `temperature`
   *  parameter (e.g. OpenAI gpt-5). Sending temperature returns a 400
   *  from the provider. */
  reasoning?: boolean;
}

/**
 * The agent's model registry. Adding a model is a one-line change here;
 * the provider switch in `providers.ts` does the rest. Model ids must
 * match the provider's own naming.
 */
export const AGENT_MODEL_DEFINITIONS = {
  // Anthropic
  //
  // IDs verified against
  // https://docs.anthropic.com/en/docs/about-claude/models/overview.
  // Per the docs, starting with the 4.6 generation the dateless
  // string IS the canonical model ID (a pinned snapshot, not an
  // evergreen alias) — that's why `claude-sonnet-4-6` and
  // `claude-opus-4-7` have no date suffix here. `claude-haiku-4-5`
  // is the alias to `claude-haiku-4-5-20251001`; both work, the
  // alias is shorter and fine to use.
  //
  // When bumping in the future, smoke-test against a real key —
  // the provider's "model not found" arrives as a stream-level
  // error the AI SDK swallows, which used to surface as a 200 OK
  // with empty body. The worker route now wires `onError` so that
  // failure mode at least becomes visible in the SSE body.
  "claude-opus-4-7": {
    name: "claude-opus-4-7",
    id: "claude-opus-4-7",
    provider: "anthropic",
  },
  "claude-sonnet-4-6": {
    name: "claude-sonnet-4-6",
    id: "claude-sonnet-4-6",
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
    reasoning: true,
  },

  // Google
  // TODO: revisit. The 2.5 generation was current when the agent
  // landed; verify against the current Generative Language API model
  // catalog (https://ai.google.dev/gemini-api/docs/models) before
  // each release, and bump the ids if Google's stable line has moved.
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

export const DEFAULT_MODEL_NAME: AgentModelName = "claude-sonnet-4-6";

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
