// Duplication / paste remapping.
// Spec: docs/design-animation-data-model.md — "Duplication & Paste Policy".
//
// Governing rule: every cross-shape identity carried in `meta.frame` —
// frame.id, stepId, trackId — gets an operation-scoped map. Relationships
// among the copied frames are preserved; links to everything outside the
// operation are severed.
//
// This is the PRIMARY mechanism: an order-independent pure transform over
// the complete copied content, run before insertion (the per-shape
// `beforeCreate` hook remains only as a safety net for creation paths that
// bypass content insertion).

import type { CueFrame, Frame, SubFrame, TimelineDoc } from "./types";
import { parseFrameMeta } from "./parse";
import { isReservedStepId } from "./ids";
import { interactiveKeyBetween } from "./keys";

export interface RemapContentInput {
  /** The copied shapes (their ids are the fresh ids of the copies). */
  shapes: { shapeId: string; frameMeta: unknown }[];
  /** Identity sets of the destination document. */
  existing: {
    frameIds: ReadonlySet<string>;
    stepIds: ReadonlySet<string>;
    trackIds: ReadonlySet<string>;
  };
  /**
   * The destination document's derived timeline, if available — used to
   * place remapped (within-document duplicated) steps directly after
   * their originals. When null, remapped steps keep their source keys.
   */
  currentDoc: TimelineDoc | null;
  /** Mints fresh ids (injectable for deterministic tests). */
  mintId: () => string;
}

export interface RemapContentResult {
  /** Replacement `meta.frame` values, keyed by (copied) shape id. */
  updatedFrames: Map<string, Frame>;
  diagnostics: { type: "ambiguous-cue-reference"; frameId: string }[];
}

/**
 * Remaps the frames carried by copied shapes. Order-independent: the
 * result is the same for any permutation of `shapes` (internal processing
 * sorts by shape id, and all identity decisions are made from the complete
 * set, never shape-at-a-time).
 */
export function remapContentFrames(
  input: RemapContentInput,
): RemapContentResult {
  const { existing, currentDoc, mintId } = input;
  const diagnostics: RemapContentResult["diagnostics"] = [];

  const sorted = [...input.shapes].sort((a, b) =>
    a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
  );

  interface ParsedEntry {
    shapeId: string;
    frame: Frame;
  }
  const entries: ParsedEntry[] = [];
  for (const { shapeId, frameMeta } of sorted) {
    const parsed = parseFrameMeta(frameMeta);
    // v1 frames and invalid frames pass through untouched here; v1 content
    // is handled by the mixed-document conversion on the destination side.
    if (parsed.kind !== "v2") continue;
    entries.push({ shapeId, frame: parsed.frame });
  }

  // --- frame.id remapping, keyed by SOURCE SHAPE ID (frame ids may be
  // --- duplicated in corrupted input; shape ids are guaranteed unique).
  const frameIdCounts = new Map<string, number>();
  for (const { frame } of entries) {
    frameIdCounts.set(frame.id, (frameIdCounts.get(frame.id) ?? 0) + 1);
  }
  const newFrameIdBySourceShapeId = new Map<string, string>();
  for (const { shapeId, frame } of entries) {
    const collides =
      existing.frameIds.has(frame.id) || (frameIdCounts.get(frame.id) ?? 0) > 1;
    newFrameIdBySourceShapeId.set(shapeId, collides ? mintId() : frame.id);
  }

  // Representative source cue per frame id (smallest shape id) for
  // resolving sub-frame `cueFrameId` references among the copies.
  const cueEntryByFrameId = new Map<string, ParsedEntry>();
  for (const entry of entries) {
    if (entry.frame.type !== "cue") continue;
    const existingEntry = cueEntryByFrameId.get(entry.frame.id);
    if (existingEntry == null || entry.shapeId < existingEntry.shapeId) {
      cueEntryByFrameId.set(entry.frame.id, entry);
    } else {
      diagnostics.push({
        type: "ambiguous-cue-reference",
        frameId: entry.frame.id,
      });
    }
  }

  // --- stepId / trackId remapping: intentionally SHARED identities, so
  // --- old-id keys are correct. Freshen on local collision (within-doc
  // --- duplication, or shared-ancestry cross-document paste) and always
  // --- for reserved-prefix ids.
  const stepIdMap = new Map<string, string>();
  const trackIdMap = new Map<string, string>();
  for (const { frame } of entries) {
    if (frame.type !== "cue") continue;
    if (
      !stepIdMap.has(frame.stepId) &&
      (existing.stepIds.has(frame.stepId) || isReservedStepId(frame.stepId))
    ) {
      stepIdMap.set(frame.stepId, mintId());
    }
    if (
      !trackIdMap.has(frame.trackId) &&
      existing.trackIds.has(frame.trackId)
    ) {
      trackIdMap.set(frame.trackId, mintId());
    }
  }

  // --- Step order keys for remapped steps: place each duplicated step
  // --- directly after its original in the destination document, keeping
  // --- the copies' relative order. Non-remapped (foreign, non-colliding)
  // --- steps keep their source keys.
  const remappedStepKey = new Map<string, string>(); // old stepId -> new key
  if (currentDoc != null) {
    for (const [oldStepId] of stepIdMap) {
      const stepIndex = currentDoc.steps.findIndex((s) => s.id === oldStepId);
      if (stepIndex < 0) continue;
      const original = currentDoc.steps[stepIndex];
      const next = currentDoc.steps[stepIndex + 1] ?? null;
      remappedStepKey.set(
        oldStepId,
        interactiveKeyBetween(
          original.orderKey,
          next != null && next.orderKey > original.orderKey
            ? next.orderKey
            : null,
        ),
      );
    }
  }

  // --- Emit remapped frames.
  const updatedFrames = new Map<string, Frame>();
  for (const { shapeId, frame } of entries) {
    const newId = newFrameIdBySourceShapeId.get(shapeId)!;
    if (frame.type === "cue") {
      const remapped: CueFrame = {
        ...frame,
        id: newId,
        stepId: stepIdMap.get(frame.stepId) ?? frame.stepId,
        stepOrderKey: remappedStepKey.get(frame.stepId) ?? frame.stepOrderKey,
        trackId: trackIdMap.get(frame.trackId) ?? frame.trackId,
      };
      updatedFrames.set(shapeId, remapped);
    } else {
      // Resolve the cue reference among the copies via the representative;
      // a reference to a cue outside the copied set is kept as-is (the
      // pasted sub arrives detached — derivation rule 3).
      const sourceCue = cueEntryByFrameId.get(frame.cueFrameId);
      const remapped: SubFrame = {
        ...frame,
        id: newId,
        cueFrameId: sourceCue
          ? newFrameIdBySourceShapeId.get(sourceCue.shapeId)!
          : frame.cueFrameId,
      };
      updatedFrames.set(shapeId, remapped);
    }
  }

  return { updatedFrames, diagnostics };
}
