import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  getAgentModelDefinition,
  isValidModelName,
  parseAgentPrompt,
  streamActions,
  type AgentEnv,
} from "@anipres/agent-core/server";
import type { AppBindings } from "../types";

// Outer envelope only — the inner `prompt` is handed off to
// `parseAgentPrompt`, which re-uses the zod schema agent-core already
// owns for LLM JSON-Schema export.
const AgentStreamRequestEnvelope = z.object({
  prompt: z.unknown(),
  modelName: z.string().optional(),
});

/**
 * Streams agent actions for the in-app chat panel.
 *
 * Caller posts `{ prompt, modelName? }` (the prompt is built from the
 * editor on the browser side) and supplies their own API key in the
 * `X-Anipres-API-Key` header — the worker is BYO-key in v0 and does not
 * persist the key.
 *
 * The response is `text/event-stream`: each `data:` line is one
 * `Streaming<AgentAction>` JSON object. The browser parses this and
 * applies actions to its editor as they arrive.
 */
export const agentRoutes = new Hono<AppBindings>().post(
  "/api/agent/stream",
  zValidator("json", AgentStreamRequestEnvelope, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "Invalid request body", issues: result.error.issues },
        400,
      );
    }
  }),
  async (c) => {
    const body = c.req.valid("json");

    const promptParse = parseAgentPrompt(body.prompt);
    if (!promptParse.success) {
      return c.json(
        { error: "Invalid prompt shape", issues: promptParse.issues },
        400,
      );
    }
    const prompt = promptParse.data;

    if (body.modelName && !isValidModelName(body.modelName)) {
      return c.json({ error: `Unknown model: ${body.modelName}` }, 400);
    }

    const apiKey = c.req.header("X-Anipres-API-Key");
    if (!apiKey) {
      // 400, not 401: the user IS authenticated (the session middleware
      // ahead of this route already let them through). The missing
      // header is a *request-shape* problem on the client. Returning
      // 401 would trick the SPA's auth handling into a re-login flow.
      return c.json({ error: "Missing X-Anipres-API-Key header" }, 400);
    }

    const env = buildEnv(body.modelName, apiKey);

    // Forward the request's abort signal so a client disconnect
    // (browser closes the SSE, user clicks Cancel and the fetch is
    // aborted, navigation, tab close) actually stops the upstream
    // model call. Without this the worker would keep draining the
    // provider stream and the user's API key would keep getting
    // billed for the rest of the response after they walked away.
    const upstreamSignal = c.req.raw.signal;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // `streamActions` (in @anipres/agent-core/server, see
        // stream-actions.ts) is the SDK boundary — it wraps Vercel
        // `ai`'s `streamText`. That SDK reports some stream-level
        // errors (provider 4xx, model-not-found, partial-stream
        // interruption) via the `onError` callback rather than
        // throwing them out of the for-await iterator, so
        // `streamActions` re-exposes the same callback for us to
        // forward. Without forwarding it, the route would exit
        // cleanly with zero events and the browser would see a 200 OK
        // with an empty body — a confusing "silent failure" mode.
        // Stash the first such error and surface it as a `data` event
        // before closing.
        //
        // Also stash the finishInfo so we can synthesise a diagnostic
        // error event when the stream completes cleanly with zero
        // actions (a separate silent-failure mode: provider says it's
        // done but never emitted any usable text — e.g. when an output
        // policy or some prompt rejection truncates the response
        // before the JSON shape is reached).
        let asyncError: unknown = null;
        let actionsYielded = 0;
        let finishInfo: { finishReason: string; text: string } | null = null;
        try {
          for await (const action of streamActions({
            prompt,
            env,
            modelName: body.modelName,
            abortSignal: upstreamSignal,
            onError: (error) => {
              if (asyncError === null) asyncError = error;
            },
            onFinish: (info) => {
              finishInfo = info;
            },
          })) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(action)}\n\n`),
            );
            actionsYielded++;
          }
          if (upstreamSignal.aborted) {
            // Client went away — no one to tell.
          } else if (asyncError !== null) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: stringifyError(asyncError) })}\n\n`,
              ),
            );
          } else if (actionsYielded === 0) {
            // Stream ended cleanly without yielding anything. Most
            // likely a provider refusal or a prompt-shape mismatch the
            // SDK didn't classify as an error. Synthesise a diagnostic
            // event with the finish reason and a snippet of the raw
            // text so the browser sees *something*.
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error: describeNoActionFailure(finishInfo),
                })}\n\n`,
              ),
            );
          }
        } catch (err) {
          // If the abort came from the client we don't have anyone to
          // tell — just close. Otherwise surface the error so the
          // browser-side parser can render it.
          if (upstreamSignal.aborted) {
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: stringifyError(err) })}\n\n`,
            ),
          );
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed (e.g. on aborted path); ignore.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
);

/**
 * Pull a human-readable string out of whatever the AI SDK / provider
 * threw or reported. The SDK frequently surfaces error objects that
 * aren't `Error` instances — e.g. `{ name, message, statusCode, …}`
 * or `{ type: "error", error: { message } }` — and `String(obj)`
 * collapses those to `"[object Object]"`, which is what the user
 * ends up seeing in the chat panel. Walk the common shapes; fall
 * back to a JSON dump (capped) when nothing matches.
 */
function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const obj = error as { message?: unknown; error?: unknown };
    if (typeof obj.message === "string") return obj.message;
    // Some SDK-level reports nest the real error one level deep:
    // `{ type: "error", error: { message: "…" } }`.
    if (obj.error !== undefined) {
      const nested = stringifyError(obj.error);
      if (nested && nested !== "[object Object]") return nested;
    }
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Compose a diagnostic message for the "stream completed cleanly,
 * yielded zero actions" path. `finishInfo.finishReason` (when
 * present) is the most useful signal — the provider tells us why it
 * stopped (`stop`, `length`, `content-filter`, etc.). The raw text
 * snippet helps when the model emitted prose preamble that the JSON
 * parser couldn't classify.
 */
function describeNoActionFailure(
  finishInfo: { finishReason: string; text: string } | null,
): string {
  const reasonPart = finishInfo
    ? `finishReason=${finishInfo.finishReason}`
    : "finishReason=unknown";
  const textPart = finishInfo?.text
    ? `; raw output: ${finishInfo.text.slice(0, 200)}${finishInfo.text.length > 200 ? "…" : ""}`
    : "; raw output empty";
  return `The model stream ended without producing any actions (${reasonPart}${textPart}). Likely a refusal, a prompt-shape mismatch, or an unsupported request parameter for the chosen model.`;
}

function buildEnv(modelName: string | undefined, apiKey: string): AgentEnv {
  if (!modelName || !isValidModelName(modelName)) {
    return { ANTHROPIC_API_KEY: apiKey };
  }
  const def = getAgentModelDefinition(modelName);
  switch (def.provider) {
    case "anthropic":
      return { ANTHROPIC_API_KEY: apiKey };
    case "openai":
      return { OPENAI_API_KEY: apiKey };
    case "google":
      return { GOOGLE_API_KEY: apiKey };
  }
}

export type AgentRoutes = typeof agentRoutes;
