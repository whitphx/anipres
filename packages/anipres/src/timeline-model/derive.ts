// The v2 derivation: shapes' `meta.frame` values → TimelineDoc.
// Spec: docs/design-animation-data-model.md — "Derivation Semantics".
//
// Total and lossless: never throws, never hides a shape. Frames are
// identified at runtime by their shapeId (the one identity tldraw
// guarantees unique); frame ids are stored data that corruption can
// duplicate, handled by rule 4.

import type {
  BatchData,
  CueFrame,
  FrameData,
  StepData,
  SubFrame,
  TimelineDiagnostic,
  TimelineDoc,
} from "./types";
import { parseFrameMeta } from "./parse";
import { makeSyntheticStepId } from "./ids";
import { compareOrderKeys } from "./order-key";

export interface DeriveTimelineInput {
  /** Raw `meta.frame` values keyed by the carrying shape. */
  shapes: { shapeId: string; frameMeta: unknown }[];
}

interface ShapeCue {
  shapeId: string;
  frame: CueFrame;
}
interface ShapeSub {
  shapeId: string;
  frame: SubFrame;
}

function byIdThenShapeId(
  a: { shapeId: string; frame: { id: string } },
  b: { shapeId: string; frame: { id: string } },
): number {
  if (a.frame.id !== b.frame.id) return a.frame.id < b.frame.id ? -1 : 1;
  return a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0;
}

export function deriveTimeline(input: DeriveTimelineInput): TimelineDoc {
  const diagnostics: TimelineDiagnostic[] = [];
  const detachedFrames: FrameData[] = [];

  // --- Parse (soft-fail).
  const cues: ShapeCue[] = [];
  const subs: ShapeSub[] = [];
  const v1ShapeIds: string[] = [];

  // Deterministic regardless of input iteration order.
  const sortedShapes = [...input.shapes].sort((a, b) =>
    a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
  );

  for (const { shapeId, frameMeta } of sortedShapes) {
    const parsed = parseFrameMeta(frameMeta);
    if (parsed.kind === "none") continue;
    if (parsed.kind === "invalid") {
      diagnostics.push({ type: "invalid-frame", shapeId });
      continue;
    }
    if (parsed.kind === "v1") {
      // v1 records are recognized, not converted: the one-time batch
      // migration is gone (design doc r9). Aggregated into one
      // diagnostic below.
      v1ShapeIds.push(shapeId);
      continue;
    }
    if (parsed.frame.type === "cue") {
      cues.push({ shapeId, frame: parsed.frame });
    } else {
      subs.push({ shapeId, frame: parsed.frame });
    }
  }

  if (v1ShapeIds.length > 0) {
    diagnostics.push({ type: "v1-frame", shapeIds: v1ShapeIds });
  }

  // --- Rule 4: duplicate frame ids — lossless. All shapes stay; ambiguous
  // --- references resolve to the representative (smallest shape id).
  const framesByFrameId = new Map<string, { shapeId: string }[]>();
  for (const entry of [...cues, ...subs]) {
    const list = framesByFrameId.get(entry.frame.id) ?? [];
    list.push({ shapeId: entry.shapeId });
    framesByFrameId.set(entry.frame.id, list);
  }
  for (const [frameId, list] of framesByFrameId) {
    if (list.length > 1) {
      diagnostics.push({
        type: "duplicate-frame-id",
        frameId,
        shapeIds: list.map((e) => e.shapeId).sort(),
      });
    }
  }

  // Representative cue per frame id (for sub attachment): smallest shapeId.
  const cueByFrameId = new Map<string, ShapeCue>();
  for (const cue of cues) {
    const existing = cueByFrameId.get(cue.frame.id);
    if (existing == null || cue.shapeId < existing.shapeId) {
      cueByFrameId.set(cue.frame.id, cue);
    }
  }

  // --- Group cues by stepId.
  const cuesByStepId = new Map<string, ShapeCue[]>();
  for (const cue of cues) {
    const list = cuesByStepId.get(cue.frame.stepId) ?? [];
    list.push(cue);
    cuesByStepId.set(cue.frame.stepId, list);
  }

  // --- Attach subs to their batch (cue), sorted by (orderKey, id, shapeId).
  const subsByCueShapeId = new Map<string, ShapeSub[]>();
  for (const sub of subs) {
    const cue = cueByFrameId.get(sub.frame.cueFrameId);
    if (cue == null) {
      // Rule 3: dangling cueFrameId — detached, surfaced, never dropped.
      detachedFrames.push({
        frameId: sub.frame.id,
        shapeId: sub.shapeId,
        action: sub.frame.action,
      });
      diagnostics.push({
        type: "detached-sub-frame",
        shapeId: sub.shapeId,
        cueFrameId: sub.frame.cueFrameId,
      });
      continue;
    }
    const list = subsByCueShapeId.get(cue.shapeId) ?? [];
    list.push(sub);
    subsByCueShapeId.set(cue.shapeId, list);
  }
  for (const list of subsByCueShapeId.values()) {
    list.sort((a, b) => {
      const keyCompare = compareOrderKeys(a.frame.orderKey, b.frame.orderKey);
      if (keyCompare !== 0) return keyCompare;
      return byIdThenShapeId(a, b);
    });
  }

  const makeBatch = (cue: ShapeCue): BatchData => ({
    trackId: cue.frame.trackId,
    frames: [
      { frameId: cue.frame.id, shapeId: cue.shapeId, action: cue.frame.action },
      ...(subsByCueShapeId.get(cue.shapeId) ?? []).map((sub) => ({
        frameId: sub.frame.id,
        shapeId: sub.shapeId,
        action: sub.frame.action,
      })),
    ],
  });

  // --- Build steps: canonical key via the stable representative (smallest
  // --- frame.id, tie-broken by shape id), rule 1 diagnosing divergence,
  // --- rule 2 splitting same-track duplicates into synthetic steps.
  interface PendingStep {
    data: StepData;
    sortKey: string;
    stepIdTieBreak: string;
    syntheticOrder: number;
  }
  const pendingSteps: PendingStep[] = [];

  for (const [stepId, members] of cuesByStepId) {
    members.sort(byIdThenShapeId);
    const representative = members[0];
    const canonicalKey = representative.frame.stepOrderKey;

    const divergent = members.filter(
      (m) => m.frame.stepOrderKey !== canonicalKey,
    );
    if (divergent.length > 0) {
      diagnostics.push({
        type: "step-key-divergence",
        stepId,
        shapeIds: members.map((m) => m.shapeId).sort(),
      });
    }

    // Rule 2: at most one batch per track per step. The first batch (by
    // frame id, then shape id) stays; later same-track batches split into
    // immediately following synthetic steps — derived behavior only.
    const keptByTrack = new Map<string, ShapeCue>();
    const split: ShapeCue[] = [];
    for (const member of members) {
      if (keptByTrack.has(member.frame.trackId)) {
        split.push(member);
      } else {
        keptByTrack.set(member.frame.trackId, member);
      }
    }

    pendingSteps.push({
      data: {
        id: stepId,
        orderKey: canonicalKey,
        batches: [...keptByTrack.values()].map(makeBatch),
      },
      sortKey: canonicalKey,
      stepIdTieBreak: stepId,
      syntheticOrder: 0,
    });

    split.forEach((member, index) => {
      diagnostics.push({
        type: "same-track-split",
        stepId,
        trackId: member.frame.trackId,
        shapeIds: [member.shapeId],
      });
      pendingSteps.push({
        data: {
          id: makeSyntheticStepId(stepId, member.shapeId),
          orderKey: canonicalKey,
          batches: [makeBatch(member)],
          synthetic: { reason: "same-track-split", sourceStepId: stepId },
        },
        sortKey: canonicalKey,
        stepIdTieBreak: stepId,
        syntheticOrder: index + 1,
      });
    });
  }

  pendingSteps.sort((a, b) => {
    const keyCompare = compareOrderKeys(a.sortKey, b.sortKey);
    if (keyCompare !== 0) return keyCompare;
    if (a.stepIdTieBreak !== b.stepIdTieBreak) {
      return a.stepIdTieBreak < b.stepIdTieBreak ? -1 : 1;
    }
    return a.syntheticOrder - b.syntheticOrder;
  });

  return {
    version: 1,
    steps: pendingSteps.map((p) => p.data),
    detachedFrames,
    diagnostics,
  };
}
