import type { TLShapeId } from "tldraw";
import {
  compareOrderKeys,
  makeInsertionSpace,
  newStepId,
  type CueFrame,
  type Frame,
  type SubFrame,
} from "../models";
import type { FrameBatchUIData, FrameUIData, Track } from "./frame-ui-data";
import { stripFrameUIData } from "./frame-ui-data";

export interface FrameMutation {
  shapeId: TLShapeId;
  frame: Frame;
}

interface LayoutBatch {
  trackId: string;
  frames: FrameUIData[];
}

type LayoutStep = LayoutBatch[];

interface RoleFrame {
  frame: FrameUIData;
  role: "cue" | "sub";
}

function toLayoutBatch(batch: FrameBatchUIData): LayoutBatch {
  return { trackId: batch.trackId, frames: [...batch.data] };
}

function rebatch(pushed: RoleFrame[], trackId: string): LayoutBatch[] {
  if (pushed.length === 0) return [];
  const frames = [
    { frame: pushed[0].frame, role: "cue" as const },
    ...pushed.slice(1),
  ];
  const batches: LayoutBatch[] = [];
  for (const item of frames) {
    if (item.role === "cue") {
      batches.push({ trackId, frames: [item.frame] });
    } else {
      batches.at(-1)!.frames.push(item.frame);
    }
  }
  return batches;
}

// Preserve the established Timeline behavior: moving a frame sweeps the
// intervening frames on its track so their playback order does not change.
function moveLayout(
  steps: FrameBatchUIData[][],
  trackId: string,
  srcStepIndex: number,
  srcTrackIndex: number,
  dstStepIndex: number,
  dstType: "after" | "at",
): LayoutStep[] | undefined {
  const sourceBatch = steps[srcStepIndex]?.find(
    (batch) =>
      batch.trackId === trackId &&
      batch.data.some((frame) => frame.trackIndex === srcTrackIndex),
  );
  if (!sourceBatch) return undefined;

  if (
    srcStepIndex < dstStepIndex ||
    (srcStepIndex === dstStepIndex && dstType === "after")
  ) {
    const destinationIndex =
      dstType === "after" ? dstStepIndex + 1 : dstStepIndex;
    const result: LayoutStep[] = [];
    const pushed: RoleFrame[] = [];
    for (let stepIndex = 0; stepIndex < steps.length + 1; stepIndex++) {
      const step = steps[stepIndex] ?? [];
      if (stepIndex < srcStepIndex) {
        result.push(step.map(toLayoutBatch));
      } else if (stepIndex === srcStepIndex) {
        const remainingStep: LayoutStep = [];
        for (const batch of step) {
          if (batch.trackId !== trackId) {
            remainingStep.push(toLayoutBatch(batch));
            continue;
          }
          const [cue, ...subs] = batch.data;
          if (cue.trackIndex === srcTrackIndex) {
            pushed.push(
              ...batch.data.map((frame) => ({ frame, role: frame.type })),
            );
            continue;
          }
          const remaining: FrameUIData[] = [cue];
          for (const sub of subs) {
            if (sub.trackIndex < srcTrackIndex) {
              remaining.push(sub);
            } else {
              pushed.push({ frame: sub, role: "sub" });
            }
          }
          remainingStep.push({ trackId, frames: remaining });
        }
        result.push(remainingStep);
      } else if (srcStepIndex < stepIndex && stepIndex < destinationIndex) {
        const remainingStep: LayoutStep = [];
        for (const batch of step) {
          if (batch.trackId !== trackId) {
            remainingStep.push(toLayoutBatch(batch));
          } else {
            pushed.push(
              ...batch.data.map((frame) => ({ frame, role: frame.type })),
            );
          }
        }
        result.push(remainingStep);
      } else if (stepIndex === destinationIndex) {
        const destinationStep: LayoutStep = [];
        let destinationBatch: FrameBatchUIData | undefined;
        for (const batch of step) {
          if (dstType === "at" && batch.trackId === trackId) {
            destinationBatch = batch;
          } else {
            destinationStep.push(toLayoutBatch(batch));
          }
        }
        if (destinationBatch) {
          if (pushed.length > 0) {
            const [cue, ...subs] = destinationBatch.data;
            pushed.push(
              { frame: cue, role: "sub" },
              ...subs.map((frame) => ({ frame, role: "sub" as const })),
            );
          } else {
            pushed.push(
              ...destinationBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        }
        let batches = rebatch(pushed, trackId);
        if (dstType === "at") {
          const lastBatch = batches.at(-1);
          if (lastBatch) {
            destinationStep.push(lastBatch);
            batches = batches.slice(0, -1);
          }
        }
        for (const batch of batches) result.push([batch]);
        result.push(destinationStep);
      } else {
        result.push(step.map(toLayoutBatch));
      }
    }
    return result.filter((step) => step.length > 0);
  }

  if (
    dstStepIndex < srcStepIndex ||
    (dstStepIndex === srcStepIndex && dstType === "after")
  ) {
    const result: LayoutStep[] = [];
    const pushed: RoleFrame[] = [];
    for (let stepIndex = steps.length - 1; stepIndex >= -1; stepIndex--) {
      const step = steps[stepIndex] ?? [];
      if (srcStepIndex < stepIndex) {
        result.unshift(step.map(toLayoutBatch));
      } else if (stepIndex === srcStepIndex) {
        const remainingStep: LayoutStep = [];
        for (const batch of step) {
          if (batch.trackId !== trackId) {
            remainingStep.push(toLayoutBatch(batch));
            continue;
          }
          const lastFrame = batch.data.at(-1);
          if (lastFrame?.trackIndex === srcTrackIndex) {
            pushed.unshift(
              ...batch.data.map((frame) => ({ frame, role: frame.type })),
            );
            continue;
          }
          const [cue, ...subs] = batch.data;
          const remaining: FrameUIData[] = [];
          for (const sub of [...subs].reverse()) {
            if (srcTrackIndex < sub.trackIndex) {
              remaining.unshift(sub);
            } else {
              pushed.unshift({ frame: sub, role: "sub" });
            }
          }
          pushed.unshift({ frame: cue, role: "cue" });
          remainingStep.push({ trackId, frames: remaining });
        }
        result.unshift(remainingStep);
      } else if (dstStepIndex < stepIndex && stepIndex < srcStepIndex) {
        const remainingStep: LayoutStep = [];
        for (const batch of step) {
          if (batch.trackId !== trackId) {
            remainingStep.push(toLayoutBatch(batch));
          } else {
            pushed.unshift(
              ...batch.data.map((frame) => ({ frame, role: frame.type })),
            );
          }
        }
        result.unshift(remainingStep);
      } else if (stepIndex === dstStepIndex) {
        const destinationStep: LayoutStep = [];
        let destinationBatch: FrameBatchUIData | undefined;
        for (const batch of step) {
          if (dstType === "at" && batch.trackId === trackId) {
            destinationBatch = batch;
          } else {
            destinationStep.push(toLayoutBatch(batch));
          }
        }
        if (destinationBatch) {
          if (pushed.length > 0) {
            pushed[0] = { frame: pushed[0].frame, role: "sub" };
            pushed.unshift(
              ...destinationBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          } else {
            pushed.unshift(
              ...destinationBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        }
        const batches = rebatch(pushed, trackId);
        const [firstBatch, ...rest] = batches;
        for (const batch of [...rest].reverse()) result.unshift([batch]);
        if (firstBatch) {
          if (dstType === "at") {
            destinationStep.push(firstBatch);
          } else {
            result.unshift([firstBatch]);
          }
        }
        result.unshift(destinationStep);
      } else {
        result.unshift(step.map(toLayoutBatch));
      }
    }
    return result.filter((step) => step.length > 0);
  }

  return undefined;
}

function assignStepIdentities(
  originalSteps: FrameBatchUIData[][],
  layout: LayoutStep[],
  stepIdRequiringNewKey?: string,
): { id: string; key: string }[] {
  const originalEntries = originalSteps
    .filter((step) => step[0] && !step[0].stepId.startsWith("synthstep:"))
    .map((step, index) => ({
      id: step[0].stepId,
      key: step[0].data[0].stepOrderKey,
      index,
    }));
  const originalById = new Map(
    originalEntries.map((entry) => [entry.id, entry]),
  );
  const candidateCounts = layout.map((step) => {
    const counts = new Map<string, number>();
    for (const batch of step) {
      const cue = batch.frames[0];
      if (cue?.type === "cue" && originalById.has(cue.stepId)) {
        counts.set(cue.stepId, (counts.get(cue.stepId) ?? 0) + 1);
      }
    }
    return counts;
  });
  const preferredStepById = new Map<string, number>();
  for (const entry of originalEntries) {
    const candidates = candidateCounts.flatMap((counts, desiredIndex) => {
      const count = counts.get(entry.id);
      return count ? [{ desiredIndex, count }] : [];
    });
    candidates.sort(
      (a, b) =>
        b.count - a.count ||
        Math.abs(a.desiredIndex - entry.index) -
          Math.abs(b.desiredIndex - entry.index) ||
        a.desiredIndex - b.desiredIndex,
    );
    if (candidates[0]) {
      preferredStepById.set(entry.id, candidates[0].desiredIndex);
    }
  }
  const identities = candidateCounts.map((counts, desiredIndex) => {
    const candidates = [...counts.entries()]
      .filter(([id]) => preferredStepById.get(id) === desiredIndex)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { id: candidates[0]?.[0] ?? newStepId(), key: "" };
  });

  const anchorIndexes = new Set<number>();
  let lastOriginalIndex = -1;
  identities.forEach((identity, desiredIndex) => {
    const original = originalById.get(identity.id);
    if (
      original &&
      identity.id !== stepIdRequiringNewKey &&
      original.index > lastOriginalIndex
    ) {
      anchorIndexes.add(desiredIndex);
      identity.key = original.key;
      lastOriginalIndex = original.index;
    }
  });
  const working = identities.flatMap((identity, desiredIndex) =>
    anchorIndexes.has(desiredIndex) ? [{ ...identity }] : [],
  );
  identities.forEach((identity, desiredIndex) => {
    if (anchorIndexes.has(desiredIndex)) return;
    const insertion = makeInsertionSpace(working, desiredIndex);
    for (const update of insertion.updates) {
      const entry = working.find((candidate) => candidate.id === update.id);
      if (entry) entry.key = update.key;
      const assigned = identities.find(
        (candidate) => candidate.id === update.id,
      );
      if (assigned) assigned.key = update.key;
    }
    identity.key = insertion.insertedKey;
    working.splice(desiredIndex, 0, { ...identity });
  });
  return identities;
}

function assignSubFrameKeys(batch: LayoutBatch): Map<TLShapeId, string> {
  const [cue, ...subs] = batch.frames;
  const existing = subs
    .filter(
      (frame): frame is FrameUIData & SubFrame =>
        frame.type === "sub" && frame.cueFrameId === cue.id,
    )
    .sort(
      (a, b) =>
        compareOrderKeys(a.orderKey, b.orderKey) ||
        a.id.localeCompare(b.id) ||
        a.shapeId.localeCompare(b.shapeId),
    );
  const originalIndexByShapeId = new Map(
    existing.map((frame, index) => [frame.shapeId, index]),
  );
  const anchors = new Set<TLShapeId>();
  let lastOriginalIndex = -1;
  for (const frame of subs) {
    const originalIndex = originalIndexByShapeId.get(frame.shapeId);
    if (originalIndex !== undefined && originalIndex > lastOriginalIndex) {
      anchors.add(frame.shapeId);
      lastOriginalIndex = originalIndex;
    }
  }
  const keyByShapeId = new Map<TLShapeId, string>();
  const working = subs.flatMap((frame) => {
    if (!anchors.has(frame.shapeId) || frame.type !== "sub") return [];
    keyByShapeId.set(frame.shapeId, frame.orderKey);
    return [{ id: frame.shapeId, key: frame.orderKey }];
  });
  subs.forEach((frame, index) => {
    if (anchors.has(frame.shapeId)) return;
    const insertion = makeInsertionSpace(working, index);
    for (const update of insertion.updates) {
      const entry = working.find((candidate) => candidate.id === update.id);
      if (entry) entry.key = update.key;
      keyByShapeId.set(update.id as TLShapeId, update.key);
    }
    keyByShapeId.set(frame.shapeId, insertion.insertedKey);
    working.splice(index, 0, {
      id: frame.shapeId,
      key: insertion.insertedKey,
    });
  });
  return keyByShapeId;
}

function reconcileLayout(
  originalSteps: FrameBatchUIData[][],
  layout: LayoutStep[],
  stepIdRequiringNewKey?: string,
): FrameMutation[] {
  const originalByShapeId = new Map(
    originalSteps
      .flatMap((step) => step)
      .flatMap((batch) => batch.data)
      .map((frame) => [frame.shapeId, stripFrameUIData(frame)]),
  );
  const identities = assignStepIdentities(
    originalSteps,
    layout,
    stepIdRequiringNewKey,
  );
  const desiredByShapeId = new Map<TLShapeId, Frame>();
  layout.forEach((step, stepIndex) => {
    const identity = identities[stepIndex];
    for (const batch of step) {
      const [cue, ...subs] = batch.frames;
      const desiredCue: CueFrame = {
        v: 2,
        id: cue.id,
        type: "cue",
        trackId: batch.trackId,
        stepId: identity.id,
        stepOrderKey: identity.key,
        action: cue.action,
      };
      desiredByShapeId.set(cue.shapeId, desiredCue);
      const subKeys = assignSubFrameKeys(batch);
      for (const sub of subs) {
        desiredByShapeId.set(sub.shapeId, {
          v: 2,
          id: sub.id,
          type: "sub",
          cueFrameId: cue.id,
          orderKey: subKeys.get(sub.shapeId)!,
          action: sub.action,
        });
      }
    }
  });
  return [...desiredByShapeId.entries()]
    .flatMap(([shapeId, frame]) =>
      JSON.stringify(originalByShapeId.get(shapeId)) === JSON.stringify(frame)
        ? []
        : [{ shapeId, frame }],
    )
    .sort((a, b) => a.shapeId.localeCompare(b.shapeId));
}

export function moveFrame(
  steps: FrameBatchUIData[][],
  trackId: Track["id"],
  srcStepIndex: number,
  srcTrackIndex: number,
  dstStepIndex: number,
  dstType: "after" | "at",
): FrameMutation[] | undefined {
  const sourceBatch = steps[srcStepIndex]?.find(
    (batch) =>
      batch.trackId === trackId &&
      batch.data.some((frame) => frame.trackIndex === srcTrackIndex),
  );
  const sourceFrame = sourceBatch?.data.find(
    (frame) => frame.trackIndex === srcTrackIndex,
  );
  const layout = moveLayout(
    steps,
    trackId,
    srcStepIndex,
    srcTrackIndex,
    dstStepIndex,
    dstType,
  );
  if (!layout || !sourceBatch || !sourceFrame) return undefined;
  const movingRight =
    srcStepIndex < dstStepIndex ||
    (srcStepIndex === dstStepIndex && dstType === "after");
  const stepIdRequiringNewKey =
    !movingRight || sourceFrame.type === "cue"
      ? sourceBatch.data[0].stepId
      : undefined;
  return reconcileLayout(steps, layout, stepIdRequiringNewKey);
}
