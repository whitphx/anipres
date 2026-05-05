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
 * Tldraw easing curves the agent may pick. A small subset chosen to cover
 * the common shapes (linear, ease-in/out, cubic) without overwhelming the
 * model's choice space.
 */
export const FocusedEasingSchema = z.enum([
  "linear",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInExpo",
  "easeOutExpo",
  "easeInOutExpo",
]);
export type FocusedEasing = z.infer<typeof FocusedEasingSchema>;

/**
 * Anipres frame action — what kind of animation the frame represents.
 * `cameraZoom` zooms the viewport to the shape's bounds.
 * `shapeAnimation` interpolates the shape's transform from its predecessor
 * (the previous frame in the same track) to its current state.
 */
export const FocusedFrameActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cameraZoom"),
      duration: z.number().optional(),
      inset: z.number().optional(),
      easing: FocusedEasingSchema.optional(),
    })
    .meta({
      title: "Camera zoom",
      description:
        "Pan and zoom the viewport to fit the shape's bounds, optionally with a duration in ms and an inset in canvas-pixels.",
    }),
  z
    .object({
      type: z.literal("shapeAnimation"),
      duration: z.number().optional(),
      easing: FocusedEasingSchema.optional(),
    })
    .meta({
      title: "Shape animation",
      description:
        "Interpolate this shape's position/rotation from the predecessor frame's shape to this one over the given duration in ms. If this is the first frame in the track, no animation runs — the shape simply becomes visible.",
    }),
]);
export type FocusedFrameAction = z.infer<typeof FocusedFrameActionSchema>;

/* ------------------------------ Focused shapes ------------------------------ */

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

export const FocusedSlideShapeSchema = z
  .object({
    _type: z.literal("slide"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  .meta({
    title: "Slide",
    description:
      "A rectangular region the camera will zoom to during presentation. Creating a slide automatically attaches a `cameraZoom` cue frame, so the slide becomes a step in the timeline.",
  });

export const FocusedShapeSchema = z.discriminatedUnion("_type", [
  FocusedRectangleSchema,
  FocusedSlideShapeSchema,
]);
export type FocusedShape = z.infer<typeof FocusedShapeSchema>;

/* --------------------------------- Actions --------------------------------- */

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
  AttachCueFrameActionSchema,
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
