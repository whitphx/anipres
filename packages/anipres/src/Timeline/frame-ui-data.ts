import { getGlobalOrder, OrderedTrackItem } from "../ordered-track-item";
import type {
  CueFrame,
  FrameAction,
  SubFrame,
  FrameBatch,
  Frame,
} from "../models";

export type CueFrameUIData<T extends FrameAction = FrameAction> =
  CueFrame<T> & {
    trackIndex: number;
  };
export type SubFrameUIData<T extends FrameAction = FrameAction> =
  SubFrame<T> & {
    trackIndex: number;
  };
export type FrameUIData<T extends FrameAction = FrameAction> =
  | CueFrameUIData<T>
  | SubFrameUIData<T>;
export type UIBatchedFrames<T extends FrameAction = FrameAction> = [
  CueFrameUIData<T>,
  ...SubFrameUIData<T>[],
];
export type UIFrameBatch<T extends FrameAction = FrameAction> =
  OrderedTrackItem<UIBatchedFrames<T>>;

export type FrameBatchUIData = UIFrameBatch & { localIndex: number };

export interface Track {
  id: string;
  type: FrameAction["type"];
  frameBatches: FrameBatchUIData[];
}

export function calcFrameBatchUIData(frameBatches: FrameBatch[]) {
  const orderedSteps = getGlobalOrder(frameBatches);
  const stepsUIData: FrameBatchUIData[][] = [];
  const tracksMap: Record<
    string,
    {
      type: FrameAction["type"];
      frameBatches: FrameBatchUIData[];
      frames: Frame[];
    }
  > = {};
  orderedSteps.forEach((stepFrameBatches, stepIndex) => {
    const frameBatchUIDatas: FrameBatchUIData[] = [];
    for (const frameBatch of stepFrameBatches) {
      const [cueFrame, ...subFrames] = frameBatch.data;
      tracksMap[frameBatch.trackId] = tracksMap[frameBatch.trackId] ?? {
        type: cueFrame.action.type,
        frameBatches: [],
        frames: [],
      };
      const frameBatchUIData: FrameBatchUIData = {
        ...frameBatch,
        globalIndex: stepIndex, // Recalculate globalIndex for each step to make this field trustworthy
        localIndex: tracksMap[frameBatch.trackId].frameBatches.length,
        data: [
          {
            ...cueFrame,
            trackIndex: tracksMap[frameBatch.trackId].frames.length,
          },
          ...subFrames.map((subFrame, index) => ({
            ...subFrame,
            trackIndex: tracksMap[frameBatch.trackId].frames.length + index + 1,
          })),
        ],
      };
      frameBatchUIDatas.push(frameBatchUIData);
      tracksMap[frameBatch.trackId].frameBatches.push(frameBatchUIData);
      tracksMap[frameBatch.trackId].frames.push(cueFrame, ...subFrames);
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
    return a.id.localeCompare(b.id);
  });

  return { steps: stepsUIData, tracks };
}
