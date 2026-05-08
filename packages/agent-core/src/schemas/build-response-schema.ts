// `buildResponseSchema` — function name and core pattern (`z.object({
// actions: z.array(actionSchema) })` then `z.toJSONSchema(...)`) come
// from tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/schema/buildResponseSchema.ts`](https://github.com/tldraw/agent-template/blob/main/shared/schema/buildResponseSchema.ts).
// Upstream additionally accepts `actionTypes`/`mode` arguments and
// strips internal `_systemPromptCategory` meta keys before emitting
// the JSON Schema; Anipres has a single mode and no internal meta
// keys yet, so neither parameterisation is needed here. See
// THIRD_PARTY_NOTICES.md at the repo root.
import * as z from "zod";
import { AgentActionSchema } from "./agent-action.js";

/**
 * Build the JSON schema injected into the system prompt. The model is
 * instructed to emit `{ "actions": [<AgentAction>, ...] }` matching this
 * schema.
 *
 * v0 always exposes the full action union. When we add Anipres-specific
 * action sets we'll start filtering by the mode's allowed action types here.
 */
export function buildResponseSchema() {
  const responseSchema = z.object({
    actions: z.array(AgentActionSchema),
  });
  return z.toJSONSchema(responseSchema);
}
