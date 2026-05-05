import type { ModelMessage } from "ai";
import type { AgentPrompt } from "../schemas/parts.js";

/**
 * Convert the prompt parts into the model-message sequence for one agent
 * turn. Prior conversation interleaves as alternating user/assistant
 * messages; the *current* user turn carries the perception (canvas +
 * presentation state) plus the user's text, since that's the state the
 * agent acts against.
 */
export function buildMessages(prompt: AgentPrompt): ModelMessage[] {
  const out: ModelMessage[] = [];

  if (prompt.chatHistory) {
    for (const turn of prompt.chatHistory.turns) {
      out.push({
        role: turn.role === "agent" ? "assistant" : "user",
        content: turn.text,
      });
    }
  }

  const lines: string[] = [];

  if (prompt.pageShapes && prompt.pageShapes.shapes.length > 0) {
    lines.push("## Current canvas");
    lines.push(JSON.stringify(prompt.pageShapes.shapes, null, 2));
  }

  if (prompt.presentationState && prompt.presentationState.totalSteps > 0) {
    lines.push("## Presentation state");
    lines.push(
      JSON.stringify(
        {
          totalSteps: prompt.presentationState.totalSteps,
          steps: prompt.presentationState.steps,
        },
        null,
        2,
      ),
    );
  }

  if (prompt.userMessages && prompt.userMessages.messages.length > 0) {
    lines.push("## User");
    for (const m of prompt.userMessages.messages) lines.push(m);
  }

  out.push({ role: "user", content: lines.join("\n\n") });

  return out;
}
