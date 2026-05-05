import type { ModePart } from "../../schemas/parts.js";

/**
 * v0 ships with a single mode that exposes every registered action and the
 * one or two perception parts a fresh canvas needs. As we add Anipres-
 * specific actions/parts we'll split this into multiple modes (e.g. an
 * "edit-shapes" mode and a "compose-presentation" mode).
 */
export function makeDefaultModePart(opts: {
  actionTypes: string[];
  partTypes: string[];
}): ModePart {
  return {
    type: "mode",
    modeType: "default",
    actionTypes: opts.actionTypes,
    partTypes: opts.partTypes,
  };
}
