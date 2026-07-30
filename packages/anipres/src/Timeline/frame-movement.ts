import type {
  EditedBatch,
  EditedStep,
  EditedStepSource,
} from "../timeline-model";
import type { FrameBatchUIData, FrameUIData, Track } from "./frame-ui-data";

// The Timeline drag & drop semantics (pinned by frame-movement.test.ts):
// moving a frame takes it — plus, within its batch, the frames on the far
// side of it relative to the move direction, plus every same-track batch
// between source and destination — and "pushes" them toward the
// destination. Frames that were cues start new batches (each becoming its
// own step); when dropped "at" a step that already has a same-track batch,
// the sequences merge into one batch.
//
// The output is a plain EditedStep[] structure; reconcileEditedSteps
// turns it into a minimal per-shape diff. Each output step that displays
// a source doc step carries that step's identity (`source`), so
// reconciliation can preserve unresolved semantic diagnostics on steps
// the edit did not touch; steps fabricated by the move carry none.

interface RoleFrame {
  frame: FrameUIData;
  role: "cue" | "sub";
}

function batchToEdited(batch: {
  trackId: string;
  frames: FrameUIData[];
}): EditedBatch {
  return {
    trackId: batch.trackId,
    frames: batch.frames.map((frame) => ({
      shapeId: frame.shapeId,
      frameId: frame.id,
      action: frame.action,
    })),
  };
}

function uiBatchToEdited(batch: FrameBatchUIData): EditedBatch {
  return batchToEdited({ trackId: batch.trackId, frames: batch.data });
}

/** Groups pushed-out frames into batches: every "cue" role starts one. */
function rebatch(pushedOut: RoleFrame[], trackId: string): EditedBatch[] {
  if (pushedOut.length === 0) {
    return [];
  }
  const withForcedFirstCue: RoleFrame[] = [
    { frame: pushedOut[0].frame, role: "cue" },
    ...pushedOut.slice(1),
  ];
  const batches: { trackId: string; frames: FrameUIData[] }[] = [];
  for (const { frame, role } of withForcedFirstCue) {
    if (role === "cue") {
      batches.push({ trackId, frames: [frame] });
    } else {
      batches.at(-1)!.frames.push(frame);
    }
  }
  return batches.map(batchToEdited);
}

export function moveFrame(
  steps: FrameBatchUIData[][],
  stepSources: readonly EditedStepSource[],
  trackId: Track["id"],
  srcGlobalIndex: number,
  srcTrackIndex: number,
  dstGlobalIndex: number,
  dstType: "after" | "at",
): EditedStep[] | undefined {
  const sourced = (batches: EditedBatch[], stepIndex: number): EditedStep => ({
    batches,
    ...(stepSources[stepIndex] != null
      ? { source: stepSources[stepIndex] }
      : {}),
  });
  if (
    srcGlobalIndex < dstGlobalIndex ||
    (srcGlobalIndex === dstGlobalIndex && dstType === "after")
  ) {
    if (dstType === "after") {
      dstGlobalIndex++;
    }
    // Move to the right
    const newSteps: EditedStep[] = [];
    const pushedOut: RoleFrame[] = [];
    for (let stepIndex = 0; stepIndex < steps.length + 1; stepIndex++) {
      // NOTE: Loop until `stepIndex` is `steps.length` to handle the case where `dstGlobalIndex = steps.length` and `dstType = "after"`.
      const step = steps[stepIndex] ?? [];
      if (stepIndex < srcGlobalIndex) {
        newSteps.push(sourced(step.map(uiBatchToEdited), stepIndex));
      } else if (stepIndex === srcGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        step.forEach((frameBatch) => {
          if (frameBatch.trackId !== trackId) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            const [cueFrame, ...subFrames] = frameBatch.data;
            if (cueFrame.trackIndex === srcTrackIndex) {
              // The whole batch moves.
              pushedOut.push(
                ...frameBatch.data.map((frame) => ({
                  frame,
                  role: frame.type,
                })),
              );
            } else {
              // The batch splits at the source frame.
              const remaining: FrameUIData[] = [cueFrame];
              subFrames.forEach((subFrame) => {
                if (subFrame.trackIndex < srcTrackIndex) {
                  remaining.push(subFrame);
                } else {
                  pushedOut.push({ frame: subFrame, role: "sub" });
                }
              });
              newStepBatches.push(
                batchToEdited({ trackId, frames: remaining }),
              );
            }
          }
        });
        newSteps.push(sourced(newStepBatches, stepIndex));
      } else if (srcGlobalIndex < stepIndex && stepIndex < dstGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        step.forEach((frameBatch) => {
          if (frameBatch.trackId !== trackId) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            pushedOut.push(
              ...frameBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        });
        newSteps.push(sourced(newStepBatches, stepIndex));
      } else if (stepIndex === dstGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        let existingDstFrameBatch: FrameBatchUIData | null = null;
        for (const frameBatch of step) {
          if (!(dstType === "at" && frameBatch.trackId === trackId)) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            existingDstFrameBatch = frameBatch;
          }
        }

        if (existingDstFrameBatch != null) {
          if (pushedOut.length > 0) {
            // Merge: the destination batch continues the moved sequence,
            // its cue demoted to a sub frame.
            const [dstCue, ...dstSubs] = existingDstFrameBatch.data;
            pushedOut.push(
              { frame: dstCue, role: "sub" },
              ...dstSubs.map((frame) => ({ frame, role: "sub" as const })),
            );
          } else {
            pushedOut.push(
              ...existingDstFrameBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        }

        let batchesToInsert = rebatch(pushedOut, trackId);
        if (dstType === "at") {
          const lastBatch = batchesToInsert.at(-1);
          if (lastBatch != null) {
            newStepBatches.push(lastBatch);
            batchesToInsert = batchesToInsert.slice(0, -1);
          }
        }
        batchesToInsert.forEach((batch) => {
          newSteps.push({ batches: [batch] });
        });
        newSteps.push(sourced(newStepBatches, stepIndex));
      } else if (dstGlobalIndex < stepIndex) {
        newSteps.push(sourced(step.map(uiBatchToEdited), stepIndex));
      }
    }
    return newSteps.filter((step) => step.batches.length > 0);
  } else if (
    dstGlobalIndex < srcGlobalIndex ||
    (dstGlobalIndex === srcGlobalIndex && dstType === "after")
  ) {
    // Move to the left
    const newSteps: EditedStep[] = [];
    const pushedOut: RoleFrame[] = [];
    for (let stepIndex = steps.length - 1; stepIndex >= -1; stepIndex--) {
      // NOTE: Loop until `stepIndex` is -1 to handle the case where `dstGlobalIndex = -1` and `dstType = "after"`.
      const step = steps[stepIndex] ?? [];
      if (srcGlobalIndex < stepIndex) {
        newSteps.unshift(sourced(step.map(uiBatchToEdited), stepIndex));
      } else if (stepIndex === srcGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        for (const frameBatch of step) {
          if (frameBatch.trackId !== trackId) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            const lastFrame = frameBatch.data.at(-1);
            if (lastFrame && lastFrame.trackIndex === srcTrackIndex) {
              // The whole batch moves.
              pushedOut.unshift(
                ...frameBatch.data.map((frame) => ({
                  frame,
                  role: frame.type,
                })),
              );
            } else {
              // The batch splits: the source frame and everything before
              // it move; the first remaining sub frame is promoted to cue.
              const [cueFrame, ...subFrames] = frameBatch.data;
              const remaining: FrameUIData[] = [];
              [...subFrames].reverse().forEach((subFrame) => {
                if (srcTrackIndex < subFrame.trackIndex) {
                  remaining.unshift(subFrame);
                } else {
                  pushedOut.unshift({ frame: subFrame, role: "sub" });
                }
              });
              pushedOut.unshift({ frame: cueFrame, role: "cue" });
              newStepBatches.push(
                batchToEdited({ trackId, frames: remaining }),
              );
            }
          }
        }
        newSteps.unshift(sourced(newStepBatches, stepIndex));
      } else if (dstGlobalIndex < stepIndex && stepIndex < srcGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        for (const frameBatch of step) {
          if (frameBatch.trackId !== trackId) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            pushedOut.unshift(
              ...frameBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        }
        newSteps.unshift(sourced(newStepBatches, stepIndex));
      } else if (stepIndex === dstGlobalIndex) {
        const newStepBatches: EditedBatch[] = [];
        let existingDstFrameBatch: FrameBatchUIData | null = null;
        for (const frameBatch of step) {
          if (!(dstType === "at" && frameBatch.trackId === trackId)) {
            newStepBatches.push(uiBatchToEdited(frameBatch));
          } else {
            existingDstFrameBatch = frameBatch;
          }
        }

        if (existingDstFrameBatch != null) {
          if (pushedOut.length > 0) {
            // Merge: the moved sequence continues the destination batch,
            // its first frame demoted to a sub frame.
            pushedOut[0] = { frame: pushedOut[0].frame, role: "sub" };
            pushedOut.unshift(
              ...existingDstFrameBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          } else {
            pushedOut.unshift(
              ...existingDstFrameBatch.data.map((frame) => ({
                frame,
                role: frame.type,
              })),
            );
          }
        }

        const batchesToInsert = rebatch(pushedOut, trackId);
        const [firstBatchToInsert, ...restBatchesToInsert] = batchesToInsert;
        [...restBatchesToInsert].reverse().forEach((batch) => {
          newSteps.unshift({ batches: [batch] });
        });
        if (firstBatchToInsert != null) {
          if (dstType === "at") {
            newStepBatches.push(firstBatchToInsert);
          } else {
            newSteps.unshift({ batches: [firstBatchToInsert] });
          }
        }
        newSteps.unshift(sourced(newStepBatches, stepIndex));
      } else if (stepIndex < dstGlobalIndex) {
        newSteps.unshift(sourced(step.map(uiBatchToEdited), stepIndex));
      }
    }
    return newSteps.filter((step) => step.batches.length > 0);
  }
}
