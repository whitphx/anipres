// `buildPromptFromEditor` follows the perception-assembly pattern
// from tldraw/agent-template (MIT, © 2024 tldraw Inc.) — iterate the
// registered part utils, project editor state into prompt parts. See
// THIRD_PARTY_NOTICES.md at the repo root.
import type { Editor } from "tldraw";
import { getRegisteredActionTypes } from "./action-util.js";
import { getPartUtil, getRegisteredPartTypes } from "./part-util.js";
import { makeChatHistoryPart } from "./parts/chat-history.js";
import { makeDefaultModePart } from "./parts/mode.js";
import { makeUserMessagesPart } from "./parts/user-messages.js";
import type { AgentPrompt, ChatHistoryTurn } from "../schemas/prompt-part.js";

export interface BuildPromptOptions {
  /** Prior turns to include as conversation history. */
  chatHistory?: ChatHistoryTurn[];
}

/**
 * Build a complete `AgentPrompt` by introspecting an editor: gather every
 * registered prompt-part util's contribution, attach the user's message,
 * and (optionally) attach prior conversation turns.
 *
 * Used by both the Node CLI (for the headless editor) and the React hook
 * (for the in-browser editor) — both perceptions are derived from the same
 * `Editor` API surface.
 */
export function buildPromptFromEditor(
  editor: Editor,
  userMessage: string,
  options: BuildPromptOptions = {},
): AgentPrompt {
  const actionTypes = getRegisteredActionTypes();
  const partTypes = getRegisteredPartTypes();
  const mode = makeDefaultModePart({ actionTypes, partTypes });

  const prompt: Record<string, unknown> = { mode };
  prompt.userMessages = makeUserMessagesPart([userMessage]);
  if (options.chatHistory && options.chatHistory.length > 0) {
    prompt.chatHistory = makeChatHistoryPart(options.chatHistory);
  }

  for (const partType of partTypes) {
    const util = getPartUtil(partType);
    if (!util) continue;
    const part = util.getPart({ editor });
    if (!part) continue;
    prompt[part.type] = part;
  }

  return prompt as AgentPrompt;
}
