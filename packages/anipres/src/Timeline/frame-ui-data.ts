import type {
  EditedStepSource,
  FrameAction,
  TimelineDoc,
} from "../timeline-model";

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

/**
 * One timeline ROW. Usually backed by a single data-model track, but
 * tracks grouped by `trackGroups` (all tracks describing one video: its
 * own keyframes plus its media events) share a row — the grouping is
 * display-only, so a step may still hold one batch from each grouped
 * track, and drag & drop keeps operating on the real per-batch track id.
 */
export interface Track {
  id: string;
  type: FrameAction["type"];
  trackIds: string[];
  frameBatches: FrameBatchUIData[];
}

/** Movement before the events that ride on the same row. */
function withinStepRank(batch: FrameBatchUIData): number {
  return batch.data[0].action.type === "mediaControl" ? 1 : 0;
}

export function calcFrameBatchUIData(
  doc: TimelineDoc,
  /** Track id → group key; tracks with the same key merge into one row. */
  trackGroups: Record<string, string> = {},
) {
  const stepsUIData: FrameBatchUIData[][] = [];
  // Parallel to `steps`: the source doc step identity each column
  // displays, threaded through structural edits so reconciliation can
  // distinguish stored / synthetic / newly-created steps.
  const stepSources: EditedStepSource[] = doc.steps.map((step) => ({
    id: step.id,
    orderKey: step.orderKey,
    ...(step.synthetic ? { synthetic: step.synthetic } : {}),
  }));
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
        id: `batch-${cueFrame.shapeId}`,
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

  const trackById = new Map<string, Track>();
  for (const [trackId, { type, frameBatches }] of Object.entries(tracksMap)) {
    const rowId = trackGroups[trackId] ?? trackId;
    let row = trackById.get(rowId);
    if (row == null) {
      row = { id: rowId, type, trackIds: [], frameBatches: [] };
      trackById.set(rowId, row);
    }
    row.trackIds.push(trackId);
    row.frameBatches.push(...frameBatches);
  }
  const tracks: Track[] = [...trackById.values()];
  for (const track of tracks) {
    // Merged rows collect batches per source track; re-order by step so
    // the row reads left to right. Two of them can share a step — a
    // video moving and one of its own events — and a step's batches
    // run concurrently, so which reads first carries no meaning and
    // cannot be dragged into a different one. Left to the derivation
    // it would come out in frame-id order, which is to say arbitrarily
    // and differently for every video, so the video's own movement is
    // put ahead of the events it carries and equal ranks fall back to
    // the track id.
    track.frameBatches.sort(
      (a, b) =>
        a.globalIndex - b.globalIndex ||
        withinStepRank(a) - withinStepRank(b) ||
        (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0),
    );
  }
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

  return { steps: stepsUIData, stepSources, tracks };
}
