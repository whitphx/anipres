// Anipres-specific (the presentation timeline's per-frame action
// vocabulary — `cameraZoom` and `shapeAnimation`). Upstream tldraw/
// agent-template has no equivalent because their canvas is not
// presentation-aware. Kept under `format/` for symmetry with the
// other focused-* primitives.
import * as z from "zod";
import { FocusedEasingSchema } from "./focused-easing.js";

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
