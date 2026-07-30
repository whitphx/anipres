// Pure planning helpers for ControlPanel operations.
//
// Everything here locates frames by the CARRYING SHAPE's id — the identity
// tldraw guarantees unique — never by the stored `frame.id`, which
// duplicate-id corruption can affect (lossless rule 4 keeps such frames in
// the derived doc, so interactive operations must not confuse them).

import {
  interactiveKeyAbove,
  makeInsertionSpace,
  type BatchData,
  type CueFrame,
  type Frame,
  type TimelineDoc,
} from "../timeline-model";

export interface FramePosition {
  stepIndex: number;
  batch: BatchData;
  /** Index within `batch.frames` (0 = the cue). */
  frameIndex: number;
}

/** Finds the doc position (step index, batch) of the frame carried by a shape. */
export function findFramePosition(
  doc: TimelineDoc,
  shapeId: string,
): FramePosition | null {
  for (let stepIndex = 0; stepIndex < doc.steps.length; stepIndex++) {
    for (const batch of doc.steps[stepIndex].batches) {
      const frameIndex = batch.frames.findIndex((f) => f.shapeId === shapeId);
      if (frameIndex >= 0) {
        return { stepIndex, batch, frameIndex };
      }
    }
  }
  return null;
}

interface CueTargetResolution {
  /** The id the sub frame must reference to attach to the TARGET cue. */
  cueFrameId: string;
  /**
   * Rewrite of the target cue itself, required when its stored id is a
   * duplicate and it is NOT the derivation representative: a sub frame
   * referencing the shared id would attach to the representative instead
   * of the selected cue, so the selected cue gets a fresh id first. The
   * caller must apply this in the SAME transaction as the sub-frame write.
   */
  cueFrameUpdate: { shapeId: string; frame: CueFrame } | null;
}

/**
 * Resolves the id a sub frame must reference to attach to the cue carried
 * by `cueShapeId`. Mirrors the derivation's representative rule (smallest
 * shapeId among CUES sharing the id): a representative — or unduplicated —
 * cue keeps its id; a non-representative duplicate gets a fresh id.
 * Freshening is safe: a non-representative cue has no attached sub frames
 * (ambiguous references all resolve to the representative), so nothing
 * detaches, and the representative's id never changes.
 */
function resolveCueTarget(input: {
  doc: TimelineDoc;
  cueShapeId: string;
  getStoredFrame: (shapeId: string) => Frame | null;
  mintId: () => string;
}): CueTargetResolution | null {
  const { doc, cueShapeId, getStoredFrame, mintId } = input;
  const storedCue = getStoredFrame(cueShapeId);
  if (storedCue?.type !== "cue") {
    return null;
  }
  let representativeShapeId = cueShapeId;
  for (const step of doc.steps) {
    for (const batch of step.batches) {
      const cue = batch.frames[0];
      if (cue.frameId === storedCue.id && cue.shapeId < representativeShapeId) {
        representativeShapeId = cue.shapeId;
      }
    }
  }
  if (representativeShapeId === cueShapeId) {
    return { cueFrameId: storedCue.id, cueFrameUpdate: null };
  }
  const freshId = mintId();
  return {
    cueFrameId: freshId,
    cueFrameUpdate: {
      shapeId: cueShapeId,
      frame: { ...storedCue, id: freshId },
    },
  };
}

export interface SubFrameAddAfterPlan {
  /** Order-key rewrites for existing sub frames (collision-run normalization). */
  keyUpdates: { shapeId: string; key: string }[];
  /** The id the new sub frame's `cueFrameId` must be set to. */
  cueFrameId: string;
  /** Order key for the new sub frame. */
  orderKey: string;
  /**
   * Rewrite of the batch's cue, present when its stored id had to be
   * freshened to make the attachment unambiguous (see resolveCueTarget).
   * Apply in the SAME transaction as the new sub frame's creation.
   */
  cueFrameUpdate: { shapeId: string; frame: CueFrame } | null;
}

/**
 * Plans inserting a new sub frame directly after the frame carried by
 * `prevShapeId` (the batch's cue counts as "before all subs"). Insertion
 * identity is the SHAPE id, so equal stored frame ids inside the batch
 * cannot make a key rewrite land on the wrong shape.
 */
export function planSubFrameAddAfter(input: {
  doc: TimelineDoc;
  prevShapeId: string;
  getStoredFrame: (shapeId: string) => Frame | null;
  mintId: () => string;
}): SubFrameAddAfterPlan | null {
  const { doc, prevShapeId, getStoredFrame, mintId } = input;
  const position = findFramePosition(doc, prevShapeId);
  if (position == null) {
    return null;
  }
  const cueTarget = resolveCueTarget({
    doc,
    cueShapeId: position.batch.frames[0].shapeId,
    getStoredFrame,
    mintId,
  });
  if (cueTarget == null) {
    return null;
  }
  const subEntries: { id: string; key: string }[] = [];
  for (const frame of position.batch.frames.slice(1)) {
    const stored = getStoredFrame(frame.shapeId);
    if (stored?.type !== "sub") {
      // The doc and the store disagree (a doc sub frame with no stored
      // sub) — bail out rather than synthesizing an invalid empty key
      // that would make key generation throw downstream.
      return null;
    }
    subEntries.push({ id: frame.shapeId, key: stored.orderKey });
  }
  // frames[0] is the cue, so the sub-list insertion index IS frameIndex.
  const insertion = makeInsertionSpace(subEntries, position.frameIndex);
  return {
    keyUpdates: insertion.updates.map(({ id, key }) => ({
      shapeId: id,
      key,
    })),
    cueFrameId: cueTarget.cueFrameId,
    orderKey: insertion.insertedKey,
    cueFrameUpdate: cueTarget.cueFrameUpdate,
  };
}

export interface DetachedReattachPlan {
  /** The id the reattached frame's `cueFrameId` must be set to. */
  cueFrameId: string;
  /** Order key placing the frame after the batch's last sub frame. */
  orderKey: string;
  /**
   * Rewrite of the target cue, present when its stored id had to be
   * freshened to make the attachment unambiguous (see resolveCueTarget).
   * Apply in the SAME transaction as the reattached frame's write.
   */
  cueFrameUpdate: { shapeId: string; frame: CueFrame } | null;
}

/**
 * Plans reattaching a detached sub frame to the cue carried by
 * `cueShapeId`, appended after that batch's last sub frame.
 */
export function planDetachedReattach(input: {
  doc: TimelineDoc;
  cueShapeId: string;
  getStoredFrame: (shapeId: string) => Frame | null;
  mintId: () => string;
}): DetachedReattachPlan | null {
  const { doc, cueShapeId, getStoredFrame, mintId } = input;
  const position = findFramePosition(doc, cueShapeId);
  if (position == null || position.frameIndex !== 0) {
    return null;
  }
  const cueTarget = resolveCueTarget({
    doc,
    cueShapeId,
    getStoredFrame,
    mintId,
  });
  if (cueTarget == null) {
    return null;
  }
  const lastSubFrameData = position.batch.frames.slice(1).at(-1);
  const lastStored =
    lastSubFrameData != null ? getStoredFrame(lastSubFrameData.shapeId) : null;
  const lastSubKey = lastStored?.type === "sub" ? lastStored.orderKey : null;
  return {
    cueFrameId: cueTarget.cueFrameId,
    orderKey: interactiveKeyAbove(lastSubKey),
    cueFrameUpdate: cueTarget.cueFrameUpdate,
  };
}
