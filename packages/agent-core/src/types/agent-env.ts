/**
 * Provider credentials. Only the providers actually used at call time are
 * required.
 *
 * Anipres-specific: tldraw/agent-template's worker hard-codes a single
 * provider (Anthropic) per deployment, so it doesn't need an env-var
 * bag. We support multi-provider BYO-key, which is what this type is
 * for.
 */
export interface AgentEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
}
