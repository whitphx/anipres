import type { FrameAction, TimelineDoc } from "../timeline-model";

export interface FrameUIData {
  id: string;
  shapeId: string;
  type: "cue" | "sub";
  action: FrameAction;
  trackIndex: number;
}
export type UIBatchedFrames = [FrameUIData, ...FrameUIData[]];

export interface FrameBatchUIData {
  id: string;
  trackId: string;
  /** The step index — recomputed from the derived doc, so trustworthy. */
  globalIndex: number;
  localIndex: number;
  data: UIBatchedFrames;
}

export interface Track {
  id: string;
  type: FrameAction["type"];
  frameBatches: FrameBatchUIData[];
}

export function calcFrameBatchUIData(doc: TimelineDoc) {
  const stepsUIData: FrameBatchUIData[][] = [];
  const tracksMap: Record<
    string,
    {
      type: FrameAction["type"];
      frameBatches: FrameBatchUIData[];
      frameCount: number;
    }
  > = {};
  doc.steps.forEach((step, stepIndex) => {
    const frameBatchUIDatas: FrameBatchUIData[] = [];
    for (const batch of step.batches) {
      const [cueFrame, ...subFrames] = batch.frames;
      if (cueFrame == null) {
        continue;
      }
      tracksMap[batch.trackId] = tracksMap[batch.trackId] ?? {
        type: cueFrame.action.type,
        frameBatches: [],
        frameCount: 0,
      };
      const trackEntry = tracksMap[batch.trackId];
      const frameBatchUIData: FrameBatchUIData = {
        id: `batch-${cueFrame.frameId}`,
        trackId: batch.trackId,
        globalIndex: stepIndex,
        localIndex: trackEntry.frameBatches.length,
        data: [
          {
            id: cueFrame.frameId,
            shapeId: cueFrame.shapeId,
            type: "cue",
            action: cueFrame.action,
            trackIndex: trackEntry.frameCount,
          },
          ...subFrames.map<FrameUIData>((subFrame, index) => ({
            id: subFrame.frameId,
            shapeId: subFrame.shapeId,
            type: "sub",
            action: subFrame.action,
            trackIndex: trackEntry.frameCount + index + 1,
          })),
        ],
      };
      frameBatchUIDatas.push(frameBatchUIData);
      trackEntry.frameBatches.push(frameBatchUIData);
      trackEntry.frameCount += batch.frames.length;
    }
    stepsUIData.push(frameBatchUIDatas);
  });

  const tracks: Track[] = Object.entries(tracksMap).map(
    ([trackId, { type, frameBatches }]) => ({
      id: trackId,
      type,
      frameBatches,
    }),
  );
  tracks.sort((a, b) => {
    // cameraZoom should be at the top
    if (a.type === "cameraZoom") {
      return -1;
    }
    if (b.type === "cameraZoom") {
      return 1;
    }
    // Code-unit comparison: locale collation would make row order vary
    // with the viewer's ICU locale.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { steps: stepsUIData, tracks };
}
