// Mirrors tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/format/FocusedColor.ts`](https://github.com/tldraw/agent-template/blob/main/shared/format/FocusedColor.ts).
// The Anipres palette is a subset of tldraw's; the upstream's wider
// palette is the reference. See THIRD_PARTY_NOTICES.md at the repo
// root.
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
