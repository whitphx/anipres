import type { ModelMessage } from "ai";
import type { AgentPrompt } from "../schemas/parts.js";

/**
 * Convert the prompt parts into the user-turn messages the model will see.
 * Order matters: the canvas + presentation projections come first so the
 * user message can refer to them by shape id, step index, etc.
 */
export function buildMessages(prompt: AgentPrompt): ModelMessage[] {
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

  return [{ role: "user", content: lines.join("\n\n") }];
}
