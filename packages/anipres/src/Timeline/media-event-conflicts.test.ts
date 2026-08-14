import { describe, it, expect } from "vitest";
import type { EditedStep, FrameAction } from "../timeline-model";
import { hasSimultaneousMediaEvents } from "./media-event-conflicts";

const play = (videoKey?: string): FrameAction => ({
  type: "mediaControl",
  command: "play",
  ...(videoKey != null ? { videoKey } : {}),
});

const move = (): FrameAction => ({ type: "shapeAnimation" });

function step(
  batches: { trackId: string; actions: FrameAction[] }[],
): EditedStep {
  return {
    batches: batches.map(({ trackId, actions }) => ({
      trackId,
      frames: actions.map((action, index) => ({
        shapeId: `${trackId}-${index}`,
        frameId: `f-${trackId}-${index}`,
        action,
      })),
    })),
  };
}

describe("hasSimultaneousMediaEvents", () => {
  it("catches two events of one video in separate batches of a step", () => {
    expect(
      hasSimultaneousMediaEvents([
        step([
          { trackId: "T-video", actions: [move(), play("vid")] },
          { trackId: "T-media", actions: [play("vid")] },
        ]),
      ]),
    ).toBe(true);
  });

  it("allows two events of one video inside one batch", () => {
    // Frames within a batch run in sequence, so their order exists and
    // is editable — that is the whole point of the sub-frame form.
    expect(
      hasSimultaneousMediaEvents([
        step([
          { trackId: "T-video", actions: [move(), play("vid"), play("vid")] },
        ]),
      ]),
    ).toBe(false);
  });

  it("allows events of different videos in one step", () => {
    expect(
      hasSimultaneousMediaEvents([
        step([
          { trackId: "T-a", actions: [play("vid-a")] },
          { trackId: "T-b", actions: [play("vid-b")] },
        ]),
      ]),
    ).toBe(false);
  });

  it("allows the same video's events in different steps", () => {
    expect(
      hasSimultaneousMediaEvents([
        step([{ trackId: "T-video", actions: [play("vid")] }]),
        step([{ trackId: "T-media", actions: [play("vid")] }]),
      ]),
    ).toBe(false);
  });

  it("ignores events that name no video yet", () => {
    expect(
      hasSimultaneousMediaEvents([
        step([
          { trackId: "T-a", actions: [play()] },
          { trackId: "T-b", actions: [play()] },
        ]),
      ]),
    ).toBe(false);
  });
});
