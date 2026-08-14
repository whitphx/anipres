import { describe, it, expect } from "vitest";
import type { EditedStep, FrameAction } from "../timeline-model";
import { editIntroducesMediaConflict } from "./media-event-conflicts";

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

/** A video's events on two tracks, both in one step. */
const conflicting = step([
  { trackId: "T-video", actions: [move(), play("vid")] },
  { trackId: "T-media", actions: [play("vid")] },
]);

const empty: EditedStep[] = [];

describe("editIntroducesMediaConflict", () => {
  it("catches two events of one video in separate batches of a step", () => {
    expect(editIntroducesMediaConflict(empty, [conflicting])).toBe(true);
  });

  it("allows an edit elsewhere while a pair already exists", () => {
    // The edited layout covers the whole timeline, so a pair reached
    // some other way must not block every later edit — including the
    // drag that would pull the two apart again.
    const before = [conflicting];
    const after = [conflicting, step([{ trackId: "T-x", actions: [move()] }])];

    expect(editIntroducesMediaConflict(before, after)).toBe(false);
  });

  it("allows two events of one video inside one batch", () => {
    // Frames within a batch run in sequence, so their order exists and
    // is editable — that is the whole point of the sub-frame form.
    const after = [
      step([
        { trackId: "T-video", actions: [move(), play("vid"), play("vid")] },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("allows events of different videos in one step", () => {
    const after = [
      step([
        { trackId: "T-a", actions: [play("vid-a")] },
        { trackId: "T-b", actions: [play("vid-b")] },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("allows the same video's events in different steps", () => {
    const after = [
      step([{ trackId: "T-video", actions: [play("vid")] }]),
      step([{ trackId: "T-media", actions: [play("vid")] }]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("ignores events that name no video yet", () => {
    const after = [
      step([
        { trackId: "T-a", actions: [play()] },
        { trackId: "T-b", actions: [play()] },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });
});
