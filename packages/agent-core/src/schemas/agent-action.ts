// Mirrors tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/schema/AgentActionSchemas.ts`](https://github.com/tldraw/agent-template/blob/main/shared/schema/AgentActionSchemas.ts).
// The "zod schemas with `.meta({ description })` doubling as the LLM's
// JSON-Schema vocabulary" pattern is from upstream. The Anipres
// schemas (slide-aware create, attachCueFrame for the presentation
// timeline) are original. See THIRD_PARTY_NOTICES.md at the repo root.
import * as z from "zod";
import { FocusedColorSchema } from "../format/focused-color.js";
import { FocusedFrameActionSchema } from "../format/focused-frame-action.js";
import { CreatableShapeSchema } from "../format/focused-shape.js";

export const MessageActionSchema = z
  .object({
    _type: z.literal("message"),
    text: z.string(),
  })
  .meta({
    title: "Message",
    description: "Send a message to the user.",
  });
export type MessageAction = z.infer<typeof MessageActionSchema>;

export const ThinkActionSchema = z
  .object({
    _type: z.literal("think"),
    text: z.string(),
  })
  .meta({
    title: "Think",
    description:
      "Reason about the task before taking visible action. The text is shown to the user as the agent's thinking but does not change the canvas.",
  });
export type ThinkAction = z.infer<typeof ThinkActionSchema>;

export const CreateActionSchema = z
  .object({
    _type: z.literal("create"),
    intent: z.string(),
    shape: CreatableShapeSchema,
  })
  .meta({
    title: "Create",
    description:
      "Create a new shape on the canvas. Currently supports `rectangle` and `slide`. To recolor or modify other shape kinds (ellipse, line, arrow, text), use the `update` action.",
  });
export type CreateAction = z.infer<typeof CreateActionSchema>;

export const UpdateShapeActionSchema = z
  .object({
    _type: z.literal("update"),
    intent: z.string(),
    shapeId: z
      .string()
      .describe("The shape to modify. Use the id from `pageShapes`."),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z
      .number()
      .optional()
      .describe(
        "New width. Ignored for shape types without a width (line, text, arrow).",
      ),
    h: z.number().optional(),
    color: FocusedColorSchema.optional(),
    text: z
      .string()
      .optional()
      .describe(
        "New text content. For text shapes this replaces the body; for geo/arrow shapes it sets the label.",
      ),
  })
  .meta({
    title: "Update",
    description:
      "Modify properties of an existing shape on the canvas. Only the supplied fields change; everything else is left intact. Common use: recoloring (`color`), repositioning (`x`, `y`), resizing (`w`, `h`), relabeling (`text`).",
  });
export type UpdateShapeAction = z.infer<typeof UpdateShapeActionSchema>;

export const DeleteShapeActionSchema = z
  .object({
    _type: z.literal("delete"),
    intent: z.string(),
    shapeId: z
      .string()
      .describe("The shape to remove. Use the id from `pageShapes`."),
  })
  .meta({
    title: "Delete",
    description:
      "Remove a shape from the canvas. Tldraw cleans up the shape's bindings and selection state. Cue/sub frames previously attached to the shape may be left behind; if you want them gone, emit explicit follow-up actions to detach or remove them.",
  });
export type DeleteShapeAction = z.infer<typeof DeleteShapeActionSchema>;

export const AttachCueFrameActionSchema = z
  .object({
    _type: z.literal("attachCueFrame"),
    intent: z.string(),
    shapeId: z.string().describe("The shape that will own this cue frame."),
    prevShapeId: z
      .string()
      .optional()
      .describe(
        "If supplied, this cue frame is added to the same track as the prev shape's frame, becoming the next step in that track. Otherwise a new track is opened.",
      ),
    action: FocusedFrameActionSchema,
  })
  .meta({
    title: "Attach Cue Frame",
    description:
      "Attach an animation cue frame to a shape — opens a track in the presentation timeline, or extends one if `prevShapeId` is given. The shape becomes visible at the step this cue lands on.",
  });
export type AttachCueFrameAction = z.infer<typeof AttachCueFrameActionSchema>;

/**
 * Discriminated union of every action the agent can emit.
 */
export const AgentActionSchema = z.discriminatedUnion("_type", [
  MessageActionSchema,
  ThinkActionSchema,
  CreateActionSchema,
  UpdateShapeActionSchema,
  DeleteShapeActionSchema,
  AttachCueFrameActionSchema,
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
