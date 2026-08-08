import { describe, expect, it } from "vitest";
import type { TimelineDoc } from "../../timeline-model";
import { listMediaEvents } from "./media-events";

function docWith(steps: TimelineDoc["steps"]): TimelineDoc {
  return { version: 1, steps, detachedFrames: [], diagnostics: [] };
}

describe("listMediaEvents", () => {
  it("returns the given markers' media events in presentation order with step indexes", () => {
    const doc = docWith([
      {
        id: "s0",
        orderKey: "a0",
        batches: [
          {
            trackId: "t-rect",
            frames: [
              {
                frameId: "f-rect",
                shapeId: "rect",
                action: { type: "shapeAnimation" },
              },
            ],
          },
        ],
      },
      {
        id: "s1",
        orderKey: "a1",
        batches: [
          {
            trackId: "t-media",
            frames: [
              {
                frameId: "f-play",
                shapeId: "marker-play",
                action: { type: "mediaControl", command: "play" },
              },
              // A chained sub frame in the same batch (play, wait, pause).
              {
                frameId: "f-pause",
                shapeId: "marker-pause",
                action: { type: "mediaControl", command: "pause" },
              },
            ],
          },
        ],
      },
      {
        id: "s2",
        orderKey: "a2",
        batches: [
          {
            trackId: "t-media",
            frames: [
              {
                frameId: "f-mute",
                shapeId: "marker-mute",
                action: { type: "mediaControl", command: "mute" },
              },
            ],
          },
          {
            trackId: "t-media-other",
            frames: [
              {
                frameId: "f-other",
                shapeId: "marker-of-other-video",
                action: { type: "mediaControl", command: "stop" },
              },
            ],
          },
        ],
      },
    ]);

    const events = listMediaEvents(
      doc,
      new Set(["marker-play", "marker-pause", "marker-mute"]),
    );

    expect(events).toEqual([
      { markerShapeId: "marker-play", command: "play", stepIndex: 1 },
      { markerShapeId: "marker-pause", command: "pause", stepIndex: 1 },
      { markerShapeId: "marker-mute", command: "mute", stepIndex: 2 },
    ]);
  });

  it("excludes non-media frames carried by the given shapes", () => {
    const doc = docWith([
      {
        id: "s0",
        orderKey: "a0",
        batches: [
          {
            trackId: "t-video",
            frames: [
              {
                frameId: "f-move",
                shapeId: "marker-keyframe",
                action: { type: "shapeAnimation" },
              },
            ],
          },
        ],
      },
    ]);

    expect(listMediaEvents(doc, new Set(["marker-keyframe"]))).toEqual([]);
  });
});
