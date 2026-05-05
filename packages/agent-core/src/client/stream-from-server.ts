import type { AgentAction } from "../schemas/actions.js";
import type { AgentPrompt } from "../schemas/parts.js";
import type { Streaming } from "../types.js";

export interface StreamFromServerOptions {
  endpoint: string;
  prompt: AgentPrompt;
  modelName?: string;
  apiKey: string;
  signal?: AbortSignal;
  /** Override the header name carrying the API key. Defaults to
   *  `X-Anipres-API-Key` to match the worker route's expectation. */
  apiKeyHeader?: string;
}

/**
 * POST a prompt to a worker endpoint and yield streaming actions parsed
 * from its `text/event-stream` response. Pairs with the worker route in
 * `packages/worker/src/routes/agent.ts`.
 */
export async function* streamFromServer(
  opts: StreamFromServerOptions,
): AsyncGenerator<Streaming<AgentAction>> {
  const res = await fetch(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [opts.apiKeyHeader ?? "X-Anipres-API-Key"]: opts.apiKey,
    },
    body: JSON.stringify({ prompt: opts.prompt, modelName: opts.modelName }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(
      `Agent stream HTTP ${res.status}: ${errBody.slice(0, 200)}`,
    );
  }
  if (!res.body) throw new Error("Agent stream returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const match = event.match(/^data: (.+)$/m);
        if (!match) continue;
        const data = JSON.parse(match[1]);
        if (typeof data === "object" && data !== null && "error" in data) {
          throw new Error(String((data as { error: unknown }).error));
        }
        yield data as Streaming<AgentAction>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
