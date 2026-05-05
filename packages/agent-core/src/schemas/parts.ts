import { z } from "zod";
import { FocusedShapeSchema } from "./actions.js";

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

export type PromptPart = UserMessagesPart | PageShapesPart | ModePart;

/**
 * A complete prompt for one agent turn. Keyed by part `type` so a part of a
 * given kind is unique per prompt.
 */
export type AgentPrompt = {
  mode: ModePart;
  userMessages?: UserMessagesPart;
  pageShapes?: PageShapesPart;
};
