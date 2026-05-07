import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getAgentModelDefinition, type AgentModelName } from "../models.js";
import type { AgentEnv } from "../types/agent-env.js";

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
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(def.id);
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for OpenAI models.");
      }
      return createOpenAI({ apiKey: env.OPENAI_API_KEY })(def.id);
    }
    case "google": {
      if (!env.GOOGLE_API_KEY) {
        throw new Error("GOOGLE_API_KEY is required for Google models.");
      }
      return createGoogleGenerativeAI({ apiKey: env.GOOGLE_API_KEY })(def.id);
    }
  }
}
