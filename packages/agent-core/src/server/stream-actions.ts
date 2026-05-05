import { streamText, type ModelMessage } from "ai";
import type { AgentAction } from "../schemas/actions.js";
import type { AgentPrompt } from "../schemas/parts.js";
import {
  DEFAULT_MODEL_NAME,
  getAgentModelDefinition,
  isValidModelName,
  type AgentModelName,
} from "../models.js";
import type { AgentEnv, Streaming } from "../types.js";
import { buildMessages } from "./build-messages.js";
import { buildSystemPrompt } from "./build-system-prompt.js";
import { closeAndParseJson } from "./close-and-parse-json.js";
import { getModel } from "./providers.js";

export interface StreamActionsOptions {
  prompt: AgentPrompt;
  env: AgentEnv;
  modelName?: string;
}

/**
 * Stream a sequence of agent actions in response to a prompt.
 *
 * Yields each action twice: once with `complete: false` while the JSON for it
 * is still streaming, then with `complete: true` once the next action begins
 * (or the stream ends). The double-yield is what enables the client-side
 * "revert and reapply" optimistic rendering.
 *
 * The model is instructed to emit `{"actions": [...]}` matching the schema
 * in the system prompt. We prefill the assistant turn with the opening of
 * that object so the model is committed to the JSON shape from the first
 * token.
 */
export async function* streamActions(
  opts: StreamActionsOptions,
): AsyncGenerator<Streaming<AgentAction>> {
  const modelName: AgentModelName = isValidModelName(opts.modelName)
    ? opts.modelName
    : DEFAULT_MODEL_NAME;
  const def = getAgentModelDefinition(modelName);
  const model = getModel(modelName, opts.env);

  const systemPrompt = buildSystemPrompt();

  const messages: ModelMessage[] = [];

  if (def.provider === "anthropic") {
    messages.push({
      role: "system",
      content: systemPrompt,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
  } else {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push(...buildMessages(opts.prompt));

  // Force the model to start emitting the JSON-action shape immediately.
  // Anthropic and Google honour this; for other providers we still seed the
  // buffer below so the parser sees a well-formed prefix.
  messages.push({
    role: "assistant",
    content: '{"actions": [{"_type":',
  });

  const { textStream } = streamText({
    model,
    messages,
    maxOutputTokens: 8192,
    temperature: 0,
  });

  yield* parseActionStream(textStream);
}

/**
 * Parse a textStream from the model into a sequence of streaming actions.
 *
 * Exposed separately so the cursor-advancement logic can be unit-tested
 * against a hand-written iterator without spinning up a real LLM.
 */
export async function* parseActionStream(
  textStream: AsyncIterable<string>,
): AsyncGenerator<Streaming<AgentAction>> {
  let buffer = '{"actions": [{"_type":';
  let cursor = 0;
  let pending: AgentAction | null = null;
  let startTime = Date.now();

  for await (const chunk of textStream) {
    buffer += chunk;

    const parsed = closeAndParseJson(buffer) as { actions?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.actions)) continue;
    const actions = parsed.actions as AgentAction[];
    if (actions.length === 0) continue;

    // The array advanced past `cursor` → the previous action is fully
    // received. Flush it as `complete: true`.
    if (actions.length > cursor) {
      const prev = actions[cursor - 1];
      if (prev) {
        yield { ...prev, complete: true, time: Date.now() - startTime };
        pending = null;
      }
      cursor++;
    }

    const current = actions[cursor - 1];
    if (current) {
      if (!pending) startTime = Date.now();
      pending = current;
      yield { ...current, complete: false, time: Date.now() - startTime };
    }
  }

  if (pending) {
    yield { ...pending, complete: true, time: Date.now() - startTime };
  }
}
