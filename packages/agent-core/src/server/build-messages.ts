// `buildMessages` — function name, signature
// (`(prompt: AgentPrompt) => ModelMessage[]`), and role (assemble the
// model-message sequence for one agent turn from the prompt parts) all
// come from tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`worker/prompt/buildMessages.ts`](https://github.com/tldraw/agent-template/blob/main/worker/prompt/buildMessages.ts).
// The body here is a simpler hard-coded sequence (chatHistory →
// pageShapes → selectedShapes → presentationState → userMessages)
// rather than upstream's polymorphic part-definition pattern with
// per-part `buildContent` / `buildMessages` callbacks and priority
// sorting — that machinery exists to compose many optional parts,
// which Anipres' single-mode setup doesn't need yet. Same load-bearing
// design (parts → ModelMessages), simpler implementation. See
// THIRD_PARTY_NOTICES.md at the repo root.
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

  if (prompt.selectedShapes && prompt.selectedShapes.shapeIds.length > 0) {
    lines.push("## User's current selection");
    lines.push(JSON.stringify(prompt.selectedShapes.shapeIds, null, 2));
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

  // All four perception/userMessages guards above are conditional, so a
  // prompt with only a `mode` part produces zero lines. Anthropic
  // rejects empty `content`, and an empty user turn is meaningless to
  // the other providers — skip it rather than letting the request 4xx.
  const content = lines.join("\n\n");
  if (content) {
    out.push({ role: "user", content });
  }

  return out;
}
