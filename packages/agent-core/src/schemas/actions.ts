import { z } from "zod";

/**
 * The set of tldraw colors the agent is allowed to use. A subset of tldraw's
 * full palette to keep the model's choice space small and predictable.
 */
export const FocusedColorSchema = z.enum([
  "black",
  "blue",
  "green",
  "grey",
  "orange",
  "red",
  "violet",
  "yellow",
]);
export type FocusedColor = z.infer<typeof FocusedColorSchema>;

/**
 * A simplified shape representation that the agent emits. Action utils
 * convert this into a real tldraw shape on apply.
 */
export const FocusedRectangleSchema = z
  .object({
    _type: z.literal("rectangle"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    color: FocusedColorSchema,
    text: z.string().default(""),
  })
  .meta({
    title: "Rectangle",
    description: "An axis-aligned rectangle, optionally with a text label.",
  });

export const FocusedShapeSchema = z.discriminatedUnion("_type", [
  FocusedRectangleSchema,
]);
export type FocusedShape = z.infer<typeof FocusedShapeSchema>;

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
    shape: FocusedShapeSchema,
  })
  .meta({
    title: "Create",
    description: "Create a new shape on the canvas.",
  });
export type CreateAction = z.infer<typeof CreateActionSchema>;

/**
 * Discriminated union of every action the agent can emit. The order of
 * schemas in the array is also the order they appear in the JSON-schema
 * union sent to the model — keep general/common actions first.
 */
export const AgentActionSchema = z.discriminatedUnion("_type", [
  MessageActionSchema,
  ThinkActionSchema,
  CreateActionSchema,
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
