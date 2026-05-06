// The streaming protocol in this file (assistant-prefill seed +
// cursor-driven partial-JSON parser yielding each action twice) is
// inspired by tldraw/agent-template (MIT, © 2024 tldraw Inc.) — that
// project is where this design first came together, and the shape of
// the implementation here owes much to it. See THIRD_PARTY_NOTICES.md
// at the repo root.
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

export interface StreamFinishInfo {
  /** "stop" | "length" | "content-filter" | "tool-calls" | "error" |
   *  "other" | "unknown" — provider-reported reason the response ended. */
  finishReason: string;
  /** Bytes of text the model actually emitted (the same content seen by
   *  `onChunk`, joined). Useful in error logs when the parser dropped
   *  everything. */
  text: string;
}

export interface StreamActionsOptions {
  prompt: AgentPrompt;
  env: AgentEnv;
  modelName?: string;
  /** Aborts the upstream model call when fired. Wire this from the
   *  request signal (worker) or the user's Cancel control. Without it,
   *  a client disconnect leaves the model call running and burns the
   *  user's API quota for the rest of the response. */
  abortSignal?: AbortSignal;
  /** Optional diagnostic hook invoked for every text chunk the model
   *  emits, before parsing. Lets callers log raw model output without
   *  reaching across the streaming machinery. Off by default. */
  onChunk?: (chunk: string) => void;
  /** Optional diagnostic hook invoked once after the model finishes,
   *  with the provider-reported finish reason and joined output text.
   *  Useful for explaining silent no-ops. Off by default. */
  onFinish?: (info: StreamFinishInfo) => void;
  /** Optional diagnostic hook invoked if the model stream errors. The
   *  AI SDK swallows some errors instead of throwing them out of the
   *  textStream iterator, so this is the only way to see them. */
  onError?: (error: unknown) => void;
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

  // Provider-specific knobs, applied unconditionally — the SDK ignores
  // options that don't match the active provider. Keeping these in one
  // place makes it cheaper to retune later.
  const geminiThinkingBudget = def.thinking ? 256 : 0;

  const { textStream } = streamText({
    model,
    messages,
    maxOutputTokens: 8192,
    temperature: 0,
    abortSignal: opts.abortSignal,
    // Anthropic needs the system prompt as a `ModelMessage` to attach a
    // cache breakpoint via `providerOptions`. The default warning about
    // system-in-messages exists to discourage prompt injection — not a
    // concern here since the system content is fixed in our own code.
    allowSystemInMessages: true,
    providerOptions: {
      anthropic: { thinking: { type: "disabled" } },
      google: { thinkingConfig: { thinkingBudget: geminiThinkingBudget } },
      openai: { reasoningEffort: "minimal" },
    },
    onFinish: ({ finishReason, text }) => {
      opts.onFinish?.({ finishReason, text });
    },
    onError: ({ error }) => {
      opts.onError?.(error);
    },
  });

  yield* parseActionStream(textStream, opts.onChunk);
}

/**
 * Parse a textStream from the model into a sequence of streaming actions.
 *
 * Exposed separately so the cursor-advancement logic can be unit-tested
 * against a hand-written iterator without spinning up a real LLM.
 */
export async function* parseActionStream(
  textStream: AsyncIterable<string>,
  onChunk?: (chunk: string) => void,
): AsyncGenerator<Streaming<AgentAction>> {
  let buffer = '{"actions": [{"_type":';
  let cursor = 0;
  let pending: AgentAction | null = null;
  let startTime = Date.now();

  for await (const chunk of textStream) {
    onChunk?.(chunk);
    buffer += chunk;

    const parsed = closeAndParseJson(buffer) as { actions?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.actions)) continue;
    const actions = parsed.actions as AgentAction[];
    if (actions.length === 0) continue;

    // The array advanced past `cursor` → every action before the new
    // tail is fully received. Loop because a single chunk can deliver
    // multiple complete actions at once (long pause then a burst), and
    // the cursor must catch up to the tail or those intermediate
    // actions never get yielded as `complete: true`.
    while (actions.length > cursor) {
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
