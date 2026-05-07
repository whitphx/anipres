// Mirrors tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/format/FocusedShape.ts`](https://github.com/tldraw/agent-template/blob/main/shared/format/FocusedShape.ts).
// The Anipres set of focused shape kinds is narrower (only what the
// agent currently needs to read or create) and adds a `slide` kind
// that has no upstream counterpart. The pattern of having a focused
// shape vocabulary distinct from tldraw's full schema, with a
// discriminated union by `_type`, is upstream's. See
// THIRD_PARTY_NOTICES.md at the repo root.
import { z } from "zod";
import { FocusedColorSchema } from "./focused-color.js";

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
      .min(2)
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
