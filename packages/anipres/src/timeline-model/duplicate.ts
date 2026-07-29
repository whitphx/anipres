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
import { makeInsertionSpace } from "./insertion-space";

/**
 * The operation being preprocessed. The caller classifies it explicitly
 * (from copy provenance + source-shape existence; see
 * `classifyRemapOperation`) — the transform never infers it from id
 * collisions (a shared-ancestry paste collides too, but the colliding
 * local step is NOT the pasted step's original):
 *
 * - "duplicate" = create a new independent copy. The copied shapes come
 *   from THIS document and their originals still exist: every copied
 *   step gets fresh shared identities and is placed directly after its
 *   original.
 * - "move" = restore the same logical animation objects after a cut.
 *   The copied shapes come from THIS document and their originals were
 *   removed: identities and relationships (frame.id, stepId,
 *   stepOrderKey, trackId, cueFrameId, sub orderKey) are preserved so
 *   the pasted shapes rejoin uncut members of their original steps,
 *   tracks, and batches. No placement-after-original. Safety fallback:
 *   a frame.id that nonetheless collides with a live record (sync
 *   introduced a record with the same id, partial deletion…) is
 *   freshened exactly as in an external paste rather than silently
 *   joining an unintended record; reserved stepIds are still freshened.
 * - "external-paste" = import content from another document. Colliding
 *   `stepId`/`trackId` values are remapped, but the pasted steps keep
 *   their source order keys (preserving their relative order); they are
 *   not repositioned relative to any colliding local step.
 */
export type RemapOperation = "duplicate" | "move" | "external-paste";

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
   * place duplicated steps directly after their originals. When null,
   * remapped steps keep their source keys.
   */
  currentDoc: TimelineDoc | null;
  operation: RemapOperation;
  /** Mints fresh ids (injectable for deterministic tests). */
  mintId: () => string;
}

export interface RemapContentResult {
  /** Replacement `meta.frame` values, keyed by (copied) shape id. */
  updatedFrames: Map<string, Frame>;
  /**
   * Step-key rewrites for EXISTING document steps, produced when placing a
   * duplicated step inside/adjacent to an equal-key run required
   * collision-run normalization. The caller must apply these in the same
   * editor transaction as the paste itself.
   */
  existingStepKeyUpdates: { stepId: string; key: string }[];
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
  const { existing, currentDoc, operation, mintId } = input;
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
    // Reserved stepIds are readable here ON PURPOSE (and freshened below):
    // paste preprocessing is the one consumer allowed to see them.
    const parsed = parseFrameMeta(frameMeta, { allowReservedStepId: true });
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

  // --- Absent-cue references: sub frames whose cue is NOT part of the
  // --- operation are severed from it, but sub frames that referenced the
  // --- SAME absent cue must stay related to each other — they get ONE
  // --- shared fresh unresolved id per absent source cue (distinct absent
  // --- cues get distinct ids). Minted over the SORTED absent-id set so
  // --- the id assignment is independent of input shape order.
  // --- A MOVE never severs: the reference points at the same logical cue
  // --- in the same document (possibly left behind by a partial cut), so
  // --- the map stays empty and the original reference is kept.
  const externalCueIdMap = new Map<string, string>();
  const absentCueIds =
    operation === "move"
      ? []
      : [
          ...new Set(
            entries.flatMap(({ frame }) =>
              frame.type === "sub" && !cueEntryByFrameId.has(frame.cueFrameId)
                ? [frame.cueFrameId]
                : [],
            ),
          ),
        ].sort();
  for (const absentCueId of absentCueIds) {
    externalCueIdMap.set(absentCueId, mintId());
  }

  // --- stepId / trackId remapping: intentionally SHARED identities, so
  // --- old-id keys are correct. Duplication freshens every copied
  // --- identity (the sources are by definition local); external paste
  // --- freshens only on local collision (shared-ancestry documents);
  // --- a move preserves both (rejoining uncut step/track members is the
  // --- point — a still-existing stepId/trackId is the rejoin target,
  // --- not a collision). Reserved-prefix ids are freshened in EVERY
  // --- operation (they must never persist).
  const stepIdMap = new Map<string, string>();
  const trackIdMap = new Map<string, string>();
  for (const { frame } of entries) {
    if (frame.type !== "cue") continue;
    if (
      !stepIdMap.has(frame.stepId) &&
      (operation === "duplicate" ||
        (operation === "external-paste" &&
          existing.stepIds.has(frame.stepId)) ||
        isReservedStepId(frame.stepId))
    ) {
      stepIdMap.set(frame.stepId, mintId());
    }
    if (
      !trackIdMap.has(frame.trackId) &&
      (operation === "duplicate" ||
        (operation === "external-paste" &&
          existing.trackIds.has(frame.trackId)))
    ) {
      trackIdMap.set(frame.trackId, mintId());
    }
  }

  // --- Step order keys. DUPLICATION places each copied step directly
  // --- after its original via collision-run-aware insertion (equal-key
  // --- runs are normalized, never fed to a bare key-between call);
  // --- EXTERNAL PASTE and MOVE keep the source keys — external paste to
  // --- preserve the pasted steps' own relative order, move because the
  // --- frames return at their original timeline positions.
  const remappedStepKey = new Map<string, string>(); // old stepId -> new key
  const existingStepKeyUpdates = new Map<string, string>(); // stepId -> key
  if (operation === "duplicate" && currentDoc != null) {
    // A working key list that accumulates prior normalizations and
    // insertions, so multiple duplicated steps compose correctly.
    const working: { id: string; key: string }[] = currentDoc.steps.map(
      (step) => ({ id: step.id, key: step.orderKey }),
    );
    const isExistingStep = new Set(working.map((entry) => entry.id));
    // Process originals in document order for deterministic placement.
    const orderedOldStepIds = currentDoc.steps
      .map((step) => step.id)
      .filter((id) => stepIdMap.has(id));
    for (const oldStepId of orderedOldStepIds) {
      const index = working.findIndex((entry) => entry.id === oldStepId);
      if (index < 0) continue;
      const insertion = makeInsertionSpace(working, index + 1);
      for (const update of insertion.updates) {
        const target = working.find((entry) => entry.id === update.id);
        if (target != null) {
          target.key = update.key;
        }
        if (isExistingStep.has(update.id)) {
          existingStepKeyUpdates.set(update.id, update.key);
        }
      }
      remappedStepKey.set(oldStepId, insertion.insertedKey);
      working.splice(index + 1, 0, {
        id: stepIdMap.get(oldStepId)!,
        key: insertion.insertedKey,
      });
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
      // Resolve the cue reference among the copies via the representative.
      // When the cue is NOT part of the operation:
      // - MOVE keeps the original reference — the cue (if it still
      //   exists) is the same logical object in the same document, so a
      //   partially cut batch reattaches to it instead of arriving
      //   detached.
      // - Duplicate/external-paste SEVER the reference with a fresh
      //   deliberately-unresolved id: keeping the original id would
      //   re-attach a within-document duplicate to the original cue (and
      //   could accidentally attach a shared-ancestry paste to an
      //   unrelated local cue). Copies that referenced the SAME absent
      //   cue share ONE unresolved id, so their grouping survives.
      const sourceCue = cueEntryByFrameId.get(frame.cueFrameId);
      const remapped: SubFrame = {
        ...frame,
        id: newId,
        cueFrameId: sourceCue
          ? newFrameIdBySourceShapeId.get(sourceCue.shapeId)!
          : operation === "move"
            ? frame.cueFrameId
            : externalCueIdMap.get(frame.cueFrameId)!,
      };
      updatedFrames.set(shapeId, remapped);
    }
  }

  return {
    updatedFrames,
    existingStepKeyUpdates: [...existingStepKeyUpdates.entries()].map(
      ([stepId, key]) => ({ stepId, key }),
    ),
    diagnostics,
  };
}
