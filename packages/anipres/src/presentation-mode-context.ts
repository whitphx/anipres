import { createContext } from "react";
import type { Atom } from "tldraw";

/**
 * Bridges the presentation-mode atom (owned by the Anipres component)
 * into shape components, which are rendered by tldraw from statically
 * registered ShapeUtils and cannot receive per-instance props any other
 * way. Provided by Anipres around <Tldraw>; null before/outside it.
 */
export const PresentationModeContext = createContext<Atom<boolean> | null>(
  null,
);
