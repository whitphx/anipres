// Anipres-specific (the agent's animation vocabulary). Upstream
// tldraw/agent-template doesn't expose easings to the agent — the
// concept lives in Anipres' presentation/animation layer. Kept under
// `format/` for symmetry with the other focused-* primitives the
// agent-template style organises here.
import { z } from "zod";

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
