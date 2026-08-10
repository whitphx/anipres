// Pure planning helpers for ControlPanel operations.
//
// Everything here locates frames by the CARRYING SHAPE's id — the identity
// tldraw guarantees unique — never by the stored `frame.id`, which
// duplicate-id corruption can affect (lossless rule 4 keeps such frames in
// the derived doc, so interactive operations must not confuse them).

import {
  makeInsertionSpace,
  orderKeyBetween,
  type BatchData,
  type CueFrame,
  type Frame,
  type FrameAction,
  type TimelineDoc,
} from "../timeline-model";

/**
 * The action for a frame added "after" an existing one (the timeline's
 * + buttons). Media commands are instantaneous, so unlike animations
 * they get no default duration — and the command must be carried over
 * for the new frame to stay valid.
 */
export function followupActionFrom(prevAction: FrameAction): FrameAction {
  if (prevAction.type === "mediaControl") {
    return {
      type: "mediaControl",
      command: prevAction.command,
      // The follow-up controls the same video: an event that lost its
      // target key would name nothing at all.
      ...(prevAction.videoKey !== undefined
        ? { videoKey: prevAction.videoKey }
        : {}),
      ...(prevAction.command === "setVolume" && prevAction.volume !== undefined
        ? { volume: prevAction.volume }
        : {}),
    };
  }
  return { type: prevAction.type, duration: 1000 };
}

/**
 * One carrier per video, keeping the order they came in.
 *
 * A video that moves is several carriers, and a request made with more
 * than one of them selected — adding a playback event, say — is still
 * one request about one video.
 */
export function oneCarrierPerVideo<T>(
  carriers: readonly T[],
  videoKeyOf: (carrier: T) => string,
): T[] {
  const seen = new Set<string>();
  return carriers.filter((carrier) => {
    const videoKey = videoKeyOf(carrier);
    if (seen.has(videoKey)) {
      return false;
    }
    seen.add(videoKey);
    return true;
  });
}

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
    orderKey: orderKeyBetween(lastSubKey, null),
    cueFrameUpdate: cueTarget.cueFrameUpdate,
  };
}

// ---------------------------------------------------------------------------
// Explicit diagnostic-resolution planners (design Risk 7). These are the
// ONLY paths that persist semantic repairs — reconciliation deliberately
// preserves unresolved step-key-divergence and same-track-split states.
// ---------------------------------------------------------------------------

const compareByFrameIdThenShapeId = (
  a: { shapeId: string; frame: Frame },
  b: { shapeId: string; frame: Frame },
) =>
  a.frame.id !== b.frame.id
    ? a.frame.id < b.frame.id
      ? -1
      : 1
    : a.shapeId < b.shapeId
      ? -1
      : a.shapeId > b.shapeId
        ? 1
        : 0;

/**
 * Plans the explicit "align step keys" repair for a `step-key-divergence`
 * diagnostic: every member converges to the canonical key — the
 * representative's (smallest frame.id, then shapeId), the same rule the
 * derivation canonicalizes with in memory.
 */
export function planStepKeyAlignment(input: {
  currentFrames: { shapeId: string; frame: Frame }[];
  stepId: string;
}): { shapeId: string; frame: CueFrame }[] {
  const members = input.currentFrames
    .filter(
      (entry): entry is { shapeId: string; frame: CueFrame } =>
        entry.frame.type === "cue" && entry.frame.stepId === input.stepId,
    )
    .sort(compareByFrameIdThenShapeId);
  const canonicalKey = members[0]?.frame.stepOrderKey;
  if (canonicalKey == null) {
    return [];
  }
  return members
    .filter((member) => member.frame.stepOrderKey !== canonicalKey)
    .map((member) => ({
      shapeId: member.shapeId,
      frame: { ...member.frame, stepOrderKey: canonicalKey },
    }));
}

export interface SameTrackSplitPlan {
  /** Step-key rewrites from collision-run normalization (existing steps). */
  stepKeyUpdates: { id: string; key: string }[];
  /** The split-off cue's rewrite: fresh stored stepId + key after source. */
  splitUpdate: { shapeId: string; frame: CueFrame };
}

/**
 * Plans the explicit "materialize split" repair for a `same-track-split`
 * diagnostic: the split-off cue gets its own stored step directly after
 * the source step. Apply `stepKeyUpdates` and `splitUpdate` in one
 * transaction.
 */
export function planSameTrackSplitMaterialization(input: {
  doc: TimelineDoc;
  currentFrames: { shapeId: string; frame: Frame }[];
  stepId: string;
  trackId: string;
  /** The diagnostic's shapeIds (the split-off members). */
  shapeIds: readonly string[];
  mintId: () => string;
}): SameTrackSplitPlan | null {
  const members = input.currentFrames
    .filter(
      (entry): entry is { shapeId: string; frame: CueFrame } =>
        entry.frame.type === "cue" &&
        entry.frame.stepId === input.stepId &&
        entry.frame.trackId === input.trackId,
    )
    .sort(compareByFrameIdThenShapeId);
  const split = members.find(
    (entry, index) => index > 0 && input.shapeIds.includes(entry.shapeId),
  );
  // Insertion space over REAL stored steps only. Synthetic recovery
  // steps are not independently stored timeline slots — they share
  // their source step's key by construction, so feeding them into
  // collision-run normalization would re-key the source and any
  // still-unresolved split members to DIFFERENT keys, fabricating a
  // step-key-divergence while resolving one member. Their reserved ids
  // must never appear in stepKeyUpdates.
  const storedSteps = input.doc.steps.filter((step) => step.synthetic == null);
  const stepIndex = storedSteps.findIndex((step) => step.id === input.stepId);
  if (split == null || stepIndex < 0) {
    return null;
  }
  const insertion = makeInsertionSpace(
    storedSteps.map((step) => ({ id: step.id, key: step.orderKey })),
    stepIndex + 1,
  );
  return {
    stepKeyUpdates: insertion.updates,
    splitUpdate: {
      shapeId: split.shapeId,
      frame: {
        ...split.frame,
        stepId: input.mintId(),
        stepOrderKey: insertion.insertedKey,
      },
    },
  };
}
