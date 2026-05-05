import { z } from "zod";
import { AgentActionSchema } from "./actions.js";

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
