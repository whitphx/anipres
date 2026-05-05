import { z } from "zod";
import { FocusedFrameActionSchema, FocusedShapeSchema } from "./actions.js";

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
 * The Anipres presentation timeline projected for the agent: total step
 * count plus, for each step, the parallel frame batches with their shape
 * ids and frame actions. This is what lets the agent reason about ordering
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
          shapeIds: z.array(z.string()),
          frameAction: FocusedFrameActionSchema,
        }),
      ),
    }),
  ),
});
export type PresentationStatePart = z.infer<typeof PresentationStatePartSchema>;

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
  | PresentationStatePart
  | ModePart;

/**
 * A complete prompt for one agent turn. Keyed by part `type` so a part of a
 * given kind is unique per prompt.
 */
export type AgentPrompt = {
  mode: ModePart;
  userMessages?: UserMessagesPart;
  pageShapes?: PageShapesPart;
  presentationState?: PresentationStatePart;
};
