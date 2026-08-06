// Mirrors tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/schema/PromptPartDefinitions.ts`](https://github.com/tldraw/agent-template/blob/main/shared/schema/PromptPartDefinitions.ts).
// The Anipres-specific parts (`presentationState`) are original; the
// pattern of one schema per prompt part keyed by a `type`
// discriminator, plus an `AgentPrompt` envelope object, is upstream's.
// See THIRD_PARTY_NOTICES.md at the repo root.
//
// The action schemas are exported as JSON Schema and embedded in the
// LLM's system prompt — `.meta({ description })` annotations carry
// the human-readable docs each action shows the model. zod's
// first-class JSON-Schema export is what makes this package commit to
// zod (the upstream pattern in tldraw/agent-template uses it for the
// same reason). Worker callers don't need to know — they import a
// typed helper (`parseAgentPrompt` below), not `z` itself.
import * as z from "zod";
import { PerceivedFrameActionSchema } from "../format/focused-frame-action.js";
import { FocusedShapeSchema } from "../format/focused-shape.js";

/**
 * A single user → agent message in the current turn. The agent receives all
 * messages joined as the user turn's content.
 */
export const UserMessagesPartSchema = z.object({
  type: z.literal("userMessages"),
  messages: z.array(z.string()),
});
export type UserMessagesPart = z.infer<typeof UserMessagesPartSchema>;

/**
 * Snapshot of shapes currently on the canvas, projected into the simplified
 * `FocusedShape` form. v0 only includes shapes the agent recognises; the rest
 * are dropped (they exist on the editor but the agent can't address them).
 */
export const PageShapesPartSchema = z.object({
  type: z.literal("pageShapes"),
  shapes: z.array(FocusedShapeSchema),
});
export type PageShapesPart = z.infer<typeof PageShapesPartSchema>;

/**
 * Shape ids the user has currently selected in the editor. Empty for
 * headless / non-UI surfaces (CLI, MCP). The agent should treat these
 * as the implicit referent of "these", "the selected", "highlighted",
 * etc. — selection is the single most reliable disambiguation signal
 * the user can give it.
 */
export const SelectedShapesPartSchema = z.object({
  type: z.literal("selectedShapes"),
  shapeIds: z.array(z.string()),
});
export type SelectedShapesPart = z.infer<typeof SelectedShapesPartSchema>;

/**
 * The Anipres presentation timeline projected for the agent: total step
 * count plus, for each step, the parallel frame batches with their
 * per-frame actions. This is what lets the agent reason about ordering
 * (e.g. "add a step after step 2").
 */
export const PresentationStatePartSchema = z.object({
  type: z.literal("presentationState"),
  totalSteps: z.number(),
  steps: z.array(
    z.object({
      index: z.number(),
      batches: z.array(
        z.object({
          trackId: z.string(),
          /** frames[0] is the cue; the rest chain after it in order. */
          frames: z.array(
            z.object({
              shapeId: z.string(),
              /**
               * mediaControl frames only: the video shape the command
               * controls (the carrying marker's parent). The carrier's
               * own shapeId does not identify the video.
               */
              targetShapeId: z.string().optional(),
              action: PerceivedFrameActionSchema,
            }),
          ),
        }),
      ),
    }),
  ),
});
export type PresentationStatePart = z.infer<typeof PresentationStatePartSchema>;

/**
 * One turn of prior conversation. The agent's textual reply (concatenated
 * `message` action text — `think` text is excluded) gets the "agent" role.
 */
export const ChatHistoryTurnSchema = z.object({
  role: z.enum(["user", "agent"]),
  text: z.string(),
});
export type ChatHistoryTurn = z.infer<typeof ChatHistoryTurnSchema>;

export const ChatHistoryPartSchema = z.object({
  type: z.literal("chatHistory"),
  turns: z.array(ChatHistoryTurnSchema),
});
export type ChatHistoryPart = z.infer<typeof ChatHistoryPartSchema>;

/**
 * Defines what actions and parts are active for this turn. Different modes
 * expose different action subsets.
 */
export const ModePartSchema = z.object({
  type: z.literal("mode"),
  modeType: z.string(),
  actionTypes: z.array(z.string()),
  partTypes: z.array(z.string()),
});
export type ModePart = z.infer<typeof ModePartSchema>;

export type PromptPart =
  | UserMessagesPart
  | PageShapesPart
  | SelectedShapesPart
  | PresentationStatePart
  | ChatHistoryPart
  | ModePart;

/**
 * A complete prompt for one agent turn. Keyed by part `type` so a part of a
 * given kind is unique per prompt.
 *
 * Validated at every untrusted entry point (the worker SSE route) so the
 * downstream pipeline can rely on shape and not redo per-field defensive
 * checks. Trusted callers (CLI, MCP server) construct prompts in-process
 * and may skip parsing.
 */
export const AgentPromptSchema = z.object({
  mode: ModePartSchema,
  userMessages: UserMessagesPartSchema.optional(),
  pageShapes: PageShapesPartSchema.optional(),
  selectedShapes: SelectedShapesPartSchema.optional(),
  presentationState: PresentationStatePartSchema.optional(),
  chatHistory: ChatHistoryPartSchema.optional(),
});
export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

export type ParseAgentPromptResult =
  | { success: true; data: AgentPrompt }
  | { success: false; issues: unknown };

/**
 * Validate an untrusted prompt at a network boundary (the worker's SSE
 * route) and return a discriminated result. Wraps zod's safeParse so
 * callers can render a 400 without taking on a direct zod import or
 * leaking the upstream error class shape across the package boundary.
 */
export function parseAgentPrompt(value: unknown): ParseAgentPromptResult {
  const result = AgentPromptSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues };
}
