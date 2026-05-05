import type { Editor } from "tldraw";
import { getRegisteredActionTypes } from "./action-util.js";
import { getPartUtil, getRegisteredPartTypes } from "./part-util.js";
import { makeDefaultModePart } from "./parts/mode.js";
import { makeUserMessagesPart } from "./parts/user-messages.js";
import type { AgentPrompt } from "../schemas/parts.js";

/**
 * Build a complete `AgentPrompt` by introspecting an editor: gather every
 * registered prompt-part util's contribution and attach the user's message.
 *
 * Used by both the Node CLI (for the headless editor) and the React hook
 * (for the in-browser editor) — both perceptions are derived from the same
 * `Editor` API surface.
 */
export function buildPromptFromEditor(
  editor: Editor,
  userMessage: string,
): AgentPrompt {
  const actionTypes = getRegisteredActionTypes();
  const partTypes = getRegisteredPartTypes();
  const mode = makeDefaultModePart({ actionTypes, partTypes });

  const prompt: Record<string, unknown> = { mode };
  prompt.userMessages = makeUserMessagesPart([userMessage]);

  for (const partType of partTypes) {
    const util = getPartUtil(partType);
    if (!util) continue;
    const part = util.getPart({ editor });
    if (!part) continue;
    prompt[part.type] = part;
  }

  return prompt as AgentPrompt;
}
