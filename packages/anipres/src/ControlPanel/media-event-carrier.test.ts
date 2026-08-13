import { describe, it, expect } from "vitest";
import type { TimelineDoc } from "../timeline-model";
import { pickMediaEventCarriers } from "./media-event-carrier";

function docWithCarriers(shapeIdsByStep: string[][]): TimelineDoc {
  return {
    version: 1,
    steps: shapeIdsByStep.map((shapeIds, stepIndex) => ({
      id: `step-${stepIndex}`,
      orderKey: `a${stepIndex}`,
      batches: [
        {
          trackId: "track-video",
          frames: shapeIds.map((shapeId) => ({
            frameId: `frame-${shapeId}`,
            shapeId,
            action: { type: "shapeAnimation" as const, duration: 0 },
          })),
        },
      ],
    })),
    detachedFrames: [],
    diagnostics: [],
  };
}

const carrier = (id: string, videoKey?: string) => ({
  id,
  meta: videoKey != null ? { videoKey } : {},
});

describe("pickMediaEventCarriers", () => {
  it("takes the last carrier of a video in presentation order", () => {
    const doc = docWithCarriers([["v1"], ["v2"], ["v3"]]);
    const shapes = [carrier("v1", "vid"), carrier("v3", "vid")];

    expect(pickMediaEventCarriers(doc, shapes)).toEqual([carrier("v3", "vid")]);
    // Selection is a set, so the same picture must give the same answer.
    expect(pickMediaEventCarriers(doc, [...shapes].reverse())).toEqual([
      carrier("v3", "vid"),
    ]);
  });

  it("orders carriers sharing a step by their place in the batch", () => {
    const doc = docWithCarriers([["v1", "v2"]]);

    expect(
      pickMediaEventCarriers(doc, [carrier("v2", "vid"), carrier("v1", "vid")]),
    ).toEqual([carrier("v2", "vid")]);
  });

  it("keeps one carrier per video when several videos are selected", () => {
    const doc = docWithCarriers([["a1"], ["b1"], ["a2"]]);

    expect(
      pickMediaEventCarriers(doc, [
        carrier("a1", "vid-a"),
        carrier("b1", "vid-b"),
        carrier("a2", "vid-a"),
      ]),
    ).toEqual([carrier("a2", "vid-a"), carrier("b1", "vid-b")]);
  });

  it("prefers a framed carrier over one with no frame at all", () => {
    const doc = docWithCarriers([["v1"]]);

    expect(
      pickMediaEventCarriers(doc, [
        carrier("unframed", "vid"),
        carrier("v1", "vid"),
      ]),
    ).toEqual([carrier("v1", "vid")]);
  });

  it("falls back to a video's sole unframed carrier", () => {
    const doc = docWithCarriers([]);

    expect(pickMediaEventCarriers(doc, [carrier("unframed", "vid")])).toEqual([
      carrier("unframed", "vid"),
    ]);
  });

  it("breaks a tie between unframed carriers the same way every time", () => {
    const doc = docWithCarriers([]);
    const shapes = [carrier("a", "vid"), carrier("b", "vid")];

    expect(pickMediaEventCarriers(doc, shapes)).toEqual([carrier("b", "vid")]);
    expect(pickMediaEventCarriers(doc, [...shapes].reverse())).toEqual([
      carrier("b", "vid"),
    ]);
  });

  it("treats carriers with no videoKey as separate videos", () => {
    const doc = docWithCarriers([["v1"], ["v2"]]);

    expect(pickMediaEventCarriers(doc, [carrier("v1"), carrier("v2")])).toEqual(
      [carrier("v1"), carrier("v2")],
    );
  });
});
