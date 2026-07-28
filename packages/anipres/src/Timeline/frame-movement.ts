import { getIndexAbove } from "tldraw";
import type { TLShapeId } from "tldraw";
import {
  makeInsertionSpace,
  newStepId,
  type CueFrame,
  type Frame,
  type SubFrame,
} from "../models";
import type { FrameBatchUIData, Track } from "./frame-ui-data";
import { stripFrameUIData } from "./frame-ui-data";

export interface FrameMutation {
  shapeId: TLShapeId;
  frame: Frame;
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
  if (!sourceBatch || !sourceFrame) return undefined;

  if (dstType === "at") {
    const targetStep = steps[dstStepIndex];
    if (!targetStep) return undefined;
    const targetBatch = targetStep.find((batch) => batch.trackId === trackId);
    if (sourceFrame.type === "cue") {
      if (targetBatch) return undefined;
      const targetCue = targetStep[0]?.data[0];
      if (!targetCue || sourceFrame.stepId === targetCue.stepId)
        return undefined;
      return [
        {
          shapeId: sourceFrame.shapeId,
          frame: {
            ...stripFrameUIData(sourceFrame),
            stepId: targetCue.stepId,
            stepOrderKey: targetCue.stepOrderKey,
          } as CueFrame,
        },
      ];
    }
    if (!targetBatch) return undefined;
    const targetCue = targetBatch.data[0];
    const lastSub = targetBatch.data.at(-1);
    return [
      {
        shapeId: sourceFrame.shapeId,
        frame: {
          ...stripFrameUIData(sourceFrame),
          cueFrameId: targetCue.id,
          orderKey:
            lastSub?.type === "sub"
              ? getIndexAbove(lastSub.orderKey as never)
              : getIndexAbove(),
        } as SubFrame,
      },
    ];
  }

  const storedSteps = steps.filter(
    (step) => step[0] && !step[0].stepId.startsWith("synthstep:"),
  );
  const insertionIndex = Math.min(dstStepIndex + 1, storedSteps.length);
  const insertion = makeInsertionSpace(
    storedSteps.map((step) => ({
      id: step[0].stepId,
      key: step[0].data[0].stepOrderKey,
    })),
    insertionIndex,
  );
  const mutations: FrameMutation[] = [];
  for (const update of insertion.updates) {
    const step = storedSteps.find((item) => item[0].stepId === update.id);
    for (const batch of step ?? []) {
      const cue = batch.data[0];
      mutations.push({
        shapeId: cue.shapeId,
        frame: {
          ...stripFrameUIData(cue),
          stepOrderKey: update.key,
        } as CueFrame,
      });
    }
  }

  const stepId = newStepId();
  const stored = stripFrameUIData(sourceFrame);
  mutations.push({
    shapeId: sourceFrame.shapeId,
    frame:
      stored.type === "cue"
        ? { ...stored, stepId, stepOrderKey: insertion.insertedKey }
        : {
            v: 2,
            id: stored.id,
            type: "cue",
            trackId,
            stepId,
            stepOrderKey: insertion.insertedKey,
            action: stored.action,
          },
  });
  return mutations;
}
