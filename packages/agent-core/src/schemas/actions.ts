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

const FocusedPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

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

export const FocusedEllipseSchema = z
  .object({
    _type: z.literal("ellipse"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    color: FocusedColorSchema,
    text: z.string().default(""),
  })
  .meta({
    title: "Ellipse",
    description:
      "An axis-aligned ellipse / oval, optionally with a text label. (x, y) is the top-left of its bounding box.",
  });

export const FocusedLineSchema = z
  .object({
    _type: z.literal("line"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    color: FocusedColorSchema,
    points: z
      .array(FocusedPointSchema)
      .describe(
        "Points along the line, in shape-local coordinates relative to (x, y). At least two points.",
      ),
  })
  .meta({
    title: "Line",
    description:
      "A polyline / freeform line. The first point is the start, the last is the end. Single-color, no arrowheads.",
  });

export const FocusedArrowSchema = z
  .object({
    _type: z.literal("arrow"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    color: FocusedColorSchema,
    start: FocusedPointSchema,
    end: FocusedPointSchema,
    text: z.string().default(""),
  })
  .meta({
    title: "Arrow",
    description:
      "A straight or bent arrow from `start` to `end`, in shape-local coordinates relative to (x, y). May carry a text label.",
  });

export const FocusedTextSchema = z
  .object({
    _type: z.literal("text"),
    shapeId: z.string(),
    x: z.number(),
    y: z.number(),
    color: FocusedColorSchema,
    text: z.string(),
  })
  .meta({
    title: "Text",
    description:
      "A free-floating text label (not attached to a shape). (x, y) is the top-left.",
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
  FocusedEllipseSchema,
  FocusedLineSchema,
  FocusedArrowSchema,
  FocusedTextSchema,
  FocusedSlideShapeSchema,
]);
export type FocusedShape = z.infer<typeof FocusedShapeSchema>;

/**
 * The subset of shape kinds the agent can `create`. Read perception
 * (`pageShapes`) covers the full `FocusedShape` union; creation is
 * intentionally narrower until per-kind create logic is added.
 */
export const CreatableShapeSchema = z.discriminatedUnion("_type", [
  FocusedRectangleSchema,
  FocusedSlideShapeSchema,
]);
export type CreatableShape = z.infer<typeof CreatableShapeSchema>;

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
  AttachCueFrameActionSchema,
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
