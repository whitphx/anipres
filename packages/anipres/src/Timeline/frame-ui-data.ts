import type {
  CueFrame,
  Frame,
  FrameAction,
  FrameRecord,
  SubFrame,
  TimelineDoc,
} from "../models";
import type { TLShapeId } from "tldraw";

export type CueFrameUIData<T extends FrameAction = FrameAction> =
  CueFrame<T> & {
    shapeId: TLShapeId;
    trackIndex: number;
  };
export type SubFrameUIData<T extends FrameAction = FrameAction> =
  SubFrame<T> & {
    shapeId: TLShapeId;
    trackIndex: number;
  };
export type FrameUIData<T extends FrameAction = FrameAction> =
  | CueFrameUIData<T>
  | SubFrameUIData<T>;
export type UIBatchedFrames<T extends FrameAction = FrameAction> = [
  CueFrameUIData<T>,
  ...SubFrameUIData<T>[],
];

export interface FrameBatchUIData<T extends FrameAction = FrameAction> {
  id: string;
  stepId: string;
  stepIndex: number;
  trackId: string;
  localIndex: number;
  data: UIBatchedFrames<T>;
}

export interface Track {
  id: string;
  type: FrameAction["type"];
  frameBatches: FrameBatchUIData[];
}

export function calcFrameBatchUIData(
  timeline: TimelineDoc,
  frameRecords: readonly FrameRecord[],
) {
  const recordByShapeId = new Map(
    frameRecords.map((record) => [record.shapeId, record]),
  );
  const tracksMap = new Map<
    string,
    {
      type: FrameAction["type"];
      frameBatches: FrameBatchUIData[];
      count: number;
    }
  >();
  const steps = timeline.steps.map((step, stepIndex) =>
    step.batches.flatMap((batch): FrameBatchUIData[] => {
      const records = batch.frames
        .map((frame) => recordByShapeId.get(frame.shapeId))
        .filter((record): record is FrameRecord => record !== undefined);
      const cueRecord = records[0];
      if (cueRecord?.frame.type !== "cue") return [];
      const cueFrame = cueRecord.frame;
      const track = tracksMap.get(batch.trackId) ?? {
        type: cueFrame.action.type,
        frameBatches: [],
        count: 0,
      };
      const data = records.map((record, index) => ({
        ...record.frame,
        shapeId: record.shapeId,
        trackIndex: track.count + index,
      })) as UIBatchedFrames;
      const frameBatch: FrameBatchUIData = {
        id: `batch-${cueRecord.shapeId}`,
        stepId: step.id,
        stepIndex,
        trackId: batch.trackId,
        localIndex: track.frameBatches.length,
        data,
      };
      track.frameBatches.push(frameBatch);
      track.count += data.length;
      tracksMap.set(batch.trackId, track);
      return [frameBatch];
    }),
  );
  const tracks: Track[] = [...tracksMap.entries()].map(
    ([id, { type, frameBatches }]) => ({ id, type, frameBatches }),
  );
  tracks.sort((a, b) => {
    if (a.type === "cameraZoom" && b.type !== "cameraZoom") return -1;
    if (b.type === "cameraZoom" && a.type !== "cameraZoom") return 1;
    return a.id.localeCompare(b.id);
  });
  return { steps, tracks };
}

export function stripFrameUIData(frame: FrameUIData): Frame {
  if (frame.type === "cue") {
    return {
      v: 2,
      id: frame.id,
      type: "cue",
      trackId: frame.trackId,
      stepId: frame.stepId,
      stepOrderKey: frame.stepOrderKey,
      action: frame.action,
    };
  }
  return {
    v: 2,
    id: frame.id,
    type: "sub",
    cueFrameId: frame.cueFrameId,
    orderKey: frame.orderKey,
    action: frame.action,
  };
}
