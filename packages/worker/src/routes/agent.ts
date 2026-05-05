import { Hono } from "hono";
import {
  AgentPromptSchema,
  getAgentModelDefinition,
  isValidModelName,
  streamActions,
  type AgentEnv,
} from "@anipres/agent-core/server";
import { z } from "zod";
import type { AppBindings } from "../types";

const AgentStreamRequestSchema = z.object({
  prompt: AgentPromptSchema,
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
  async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AgentStreamRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request body",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const body = parsed.data;

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
        try {
          for await (const action of streamActions({
            prompt: body.prompt,
            env,
            modelName: body.modelName,
            abortSignal: upstreamSignal,
          })) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(action)}\n\n`),
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
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`),
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
