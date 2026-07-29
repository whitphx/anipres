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

export interface SubFrameAddAfterPlan {
  /** Order-key rewrites for existing sub frames (collision-run normalization). */
  keyUpdates: { shapeId: string; key: string }[];
  /** Stored id of the batch's cue — the new sub frame's `cueFrameId`. */
  cueFrameId: string;
  /** Order key for the new sub frame. */
  orderKey: string;
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
}): SubFrameAddAfterPlan | null {
  const { doc, prevShapeId, getStoredFrame } = input;
  const position = findFramePosition(doc, prevShapeId);
  if (position == null) {
    return null;
  }
  const subEntries = position.batch.frames.slice(1).map((frame) => {
    const stored = getStoredFrame(frame.shapeId);
    return {
      id: frame.shapeId,
      key: stored?.type === "sub" ? stored.orderKey : "",
    };
  });
  // frames[0] is the cue, so the sub-list insertion index IS frameIndex.
  const insertion = makeInsertionSpace(subEntries, position.frameIndex);
  return {
    keyUpdates: insertion.updates.map(({ id, key }) => ({
      shapeId: id,
      key,
    })),
    cueFrameId: position.batch.frames[0].frameId,
    orderKey: insertion.insertedKey,
  };
}

export interface DetachedReattachPlan {
  /** Stored id of the target cue — the reattached frame's `cueFrameId`. */
  cueFrameId: string;
  /** Order key placing the frame after the batch's last sub frame. */
  orderKey: string;
}

/**
 * Plans reattaching a detached sub frame to the cue carried by
 * `cueShapeId`, appended after that batch's last sub frame.
 */
export function planDetachedReattach(input: {
  doc: TimelineDoc;
  cueShapeId: string;
  getStoredFrame: (shapeId: string) => Frame | null;
}): DetachedReattachPlan | null {
  const { doc, cueShapeId, getStoredFrame } = input;
  const position = findFramePosition(doc, cueShapeId);
  if (position == null || position.frameIndex !== 0) {
    return null;
  }
  const lastSubFrameData = position.batch.frames.slice(1).at(-1);
  const lastStored =
    lastSubFrameData != null ? getStoredFrame(lastSubFrameData.shapeId) : null;
  const lastSubKey = lastStored?.type === "sub" ? lastStored.orderKey : null;
  return {
    cueFrameId: position.batch.frames[0].frameId,
    orderKey: interactiveKeyAbove(lastSubKey),
  };
}
