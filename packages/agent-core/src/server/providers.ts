import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { getAgentModelDefinition, type AgentModelName } from "../models.js";
import type { AgentEnv } from "../types.js";

/**
 * Resolve a model name to an `ai`-SDK `LanguageModel` using the supplied env
 * for credentials. Throws if the relevant API key isn't set.
 */
export function getModel(
  modelName: AgentModelName,
  env: AgentEnv,
): LanguageModel {
  const def = getAgentModelDefinition(modelName);
  switch (def.provider) {
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is required for Anthropic models.");
      }
      const provider = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
      return provider(def.id);
    }
    case "openai":
      throw new Error("OpenAI provider is not enabled in this build.");
    case "google":
      throw new Error("Google provider is not enabled in this build.");
  }
}
