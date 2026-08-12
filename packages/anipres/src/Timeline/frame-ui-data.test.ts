import { describe, it, expect } from "vitest";
import { calcFrameBatchUIData } from "./frame-ui-data";
import { deriveTimeline } from "../timeline-model";
import type { CueFrame, TimelineDoc } from "../timeline-model";

function cue(
  id: string,
  stepId: string,
  stepOrderKey: string,
  trackId: string,
  action: CueFrame["action"] = { type: "shapeAnimation" },
): CueFrame {
  return { v: 2, id, type: "cue", trackId, stepId, stepOrderKey, action };
}

// One video: its appearance track T-video (carried by the video shape)
// and its media track T-media (carried by markers), plus an unrelated
// track T-other.
const DOC = deriveTimeline({
  shapes: [
    { shapeId: "shape:video", frameMeta: cue("v1", "s1", "a1", "T-video") },
    {
      shapeId: "shape:marker",
      frameMeta: cue("m1", "s2", "a2", "T-media", {
        type: "mediaControl",
        command: "play",
      }),
    },
    { shapeId: "shape:x", frameMeta: cue("x1", "s2", "a2", "T-other") },
  ],
});

describe("calcFrameBatchUIData track grouping", () => {
  it("keeps one row per track without groups", () => {
    const { tracks } = calcFrameBatchUIData(DOC);
    expect(tracks.map((t) => t.trackIds)).toEqual([
      ["T-media"],
      ["T-other"],
      ["T-video"],
    ]);
  });

  it("merges grouped tracks into one row keyed by the group", () => {
    const { tracks } = calcFrameBatchUIData(DOC, {
      "T-video": "shape:video",
      "T-media": "shape:video",
    });
    expect(tracks).toHaveLength(2);
    const merged = tracks.find((t) => t.id === "shape:video")!;
    expect([...merged.trackIds].sort()).toEqual(["T-media", "T-video"]);
    // Batches read left to right across the merged row, and each keeps
    // its real track id for drag & drop.
    expect(merged.frameBatches.map((b) => [b.globalIndex, b.trackId])).toEqual([
      [0, "T-video"],
      [1, "T-media"],
    ]);
    const other = tracks.find((t) => t.id === "T-other")!;
    expect(other.trackIds).toEqual(["T-other"]);
  });

  it("keeps per-track trackIndex numbering under grouping", () => {
    const grouped = calcFrameBatchUIData(DOC, {
      "T-video": "shape:video",
      "T-media": "shape:video",
    });
    const ungrouped = calcFrameBatchUIData(DOC);
    // Grouping is display-only: the frames' (trackId, trackIndex)
    // coordinates — what drag & drop operates on — are unchanged.
    expect(grouped.steps).toEqual(ungrouped.steps);
  });
});

describe("a video's row when a step holds movement and an event", () => {
  it("reads the movement first, whatever ids the frames were minted", () => {
    // Both tracks describe one video, so they share a row, and both
    // have a batch in step 0. Frame ids decide nothing here: the media
    // event's sorts ahead of the movement's.
    const doc: TimelineDoc = {
      version: 1,
      detachedFrames: [],
      steps: [
        {
          id: "s0",
          orderKey: "a1",
          batches: [
            {
              trackId: "T-media",
              frames: [
                {
                  frameId: "aaa-event",
                  shapeId: "shape:marker",
                  action: { type: "mediaControl", command: "play" },
                },
              ],
            },
            {
              trackId: "T-video",
              frames: [
                {
                  frameId: "zzz-move",
                  shapeId: "shape:video",
                  action: { type: "shapeAnimation" },
                },
              ],
            },
          ],
        },
      ],
      diagnostics: [],
    };

    const { tracks } = calcFrameBatchUIData(doc, {
      "T-media": "video-key",
      "T-video": "video-key",
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0].frameBatches.map((b) => b.trackId)).toEqual([
      "T-video",
      "T-media",
    ]);
    // The cue frame's own id travels into the row, which a fixture
    // naming the field wrongly would leave undefined.
    expect(tracks[0].frameBatches.map((b) => b.data[0].id)).toEqual([
      "zzz-move",
      "aaa-event",
    ]);
  });
});
