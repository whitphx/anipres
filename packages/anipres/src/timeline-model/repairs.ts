// User-triggered semantic repair planning (design Risk 7). Pure functions
// so the repair rules are unit-testable; the ControlPanel applies the
// returned writes in one editor transaction.

import type { Frame } from "./types";

export interface DuplicateFrameIdRepairPlan {
  /** Shapes whose frame must be rewritten with a fresh id. */
  updates: { shapeId: string; frame: Frame }[];
}

/**
 * Plans the repair for a `duplicate-frame-id` diagnostic.
 *
 * Keeper rule — deliberately the SAME representative the derivation uses
 * to resolve ambiguous `cueFrameId` references, so the repair never
 * detaches a sub frame that was attached before it:
 *
 * 1. If the duplicates include cue frames, the smallest-`shapeId` CUE
 *    keeps the id (referencing sub frames stay attached to it).
 * 2. Otherwise the smallest-`shapeId` record keeps it.
 * 3. Every other duplicate gets a fresh id.
 */
export function planDuplicateFrameIdRepair(
  currentFrames: { shapeId: string; frame: Frame }[],
  frameId: string,
  mintId: () => string,
): DuplicateFrameIdRepairPlan {
  const duplicates = currentFrames
    .filter((entry) => entry.frame.id === frameId)
    .sort((a, b) =>
      a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
    );
  if (duplicates.length <= 1) {
    return { updates: [] };
  }
  const keeper =
    duplicates.find((entry) => entry.frame.type === "cue") ?? duplicates[0];
  return {
    updates: duplicates
      .filter((entry) => entry.shapeId !== keeper.shapeId)
      .map((entry) => ({
        shapeId: entry.shapeId,
        frame: { ...entry.frame, id: mintId() },
      })),
  };
}
