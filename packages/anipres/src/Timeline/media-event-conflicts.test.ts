import { describe, it, expect } from "vitest";
import type { EditedStep, FrameAction } from "../timeline-model";
import { editIntroducesMediaConflict } from "./media-event-conflicts";

const play = (videoKey?: string): FrameAction => ({
  type: "mediaControl",
  command: "play",
  ...(videoKey != null ? { videoKey } : {}),
});

const move = (): FrameAction => ({ type: "shapeAnimation" });

/**
 * A step of batches, each given as `trackId` plus one entry per frame:
 * the carrying shape's id and its action.
 */
function step(
  batches: { trackId: string; frames: [string, FrameAction][] }[],
): EditedStep {
  return {
    batches: batches.map(({ trackId, frames }) => ({
      trackId,
      frames: frames.map(([shapeId, action]) => ({
        shapeId,
        frameId: `f-${shapeId}`,
        action,
      })),
    })),
  };
}

/** One video's events on two tracks of one step. */
const conflictOf = (videoKey: string, a: string, b: string) =>
  step([
    {
      trackId: `T-${videoKey}-move`,
      frames: [
        [`${a}-cue`, move()],
        [a, play(videoKey)],
      ],
    },
    { trackId: `T-${videoKey}-media`, frames: [[b, play(videoKey)]] },
  ]);

const empty: EditedStep[] = [];

describe("editIntroducesMediaConflict", () => {
  it("catches two events of one video in separate batches of a step", () => {
    expect(
      editIntroducesMediaConflict(empty, [conflictOf("vid", "e1", "e2")]),
    ).toBe(true);
  });

  it("allows an edit elsewhere while a conflict already exists", () => {
    // The edited layout covers the whole timeline, so a conflict
    // reached some other way must not block every later edit —
    // including the drag that would pull the two apart again.
    const existing = conflictOf("vid", "e1", "e2");
    const after = [
      existing,
      step([{ trackId: "T-x", frames: [["x1", move()]] }]),
    ];

    expect(editIntroducesMediaConflict([existing], after)).toBe(false);
  });

  it("catches a new conflict while another one is already present", () => {
    const existing = conflictOf("vid-a", "a1", "a2");

    expect(
      editIntroducesMediaConflict(
        [existing],
        [existing, conflictOf("vid-b", "b1", "b2")],
      ),
    ).toBe(true);
  });

  it("catches a third event pulled into an existing conflict", () => {
    const after = step([
      {
        trackId: "T-vid-move",
        frames: [
          ["e1-cue", move()],
          ["e1", play("vid")],
        ],
      },
      { trackId: "T-vid-media", frames: [["e2", play("vid")]] },
      { trackId: "T-third", frames: [["e3", play("vid")]] },
    ]);

    expect(
      editIntroducesMediaConflict([conflictOf("vid", "e1", "e2")], [after]),
    ).toBe(true);
  });

  it("allows dragging an event out of a conflict that has three", () => {
    const before = step([
      { trackId: "T-a", frames: [["e1", play("vid")]] },
      { trackId: "T-b", frames: [["e2", play("vid")]] },
      { trackId: "T-c", frames: [["e3", play("vid")]] },
    ]);
    const after = [
      step([
        { trackId: "T-a", frames: [["e1", play("vid")]] },
        { trackId: "T-b", frames: [["e2", play("vid")]] },
      ]),
      step([{ trackId: "T-c", frames: [["e3", play("vid")]] }]),
    ];

    // Strictly fewer events running at once. Refusing this would trap
    // the user in a conflict they can only leave in one move.
    expect(editIntroducesMediaConflict([before], after)).toBe(false);
  });

  it("catches an event pulled out of the batch it ran in sequence with", () => {
    const before = step([
      {
        trackId: "T-a",
        frames: [
          ["e1", play("vid")],
          ["e2", play("vid")],
        ],
      },
      { trackId: "T-b", frames: [["e3", play("vid")]] },
    ]);
    // The same three events, regrouped: e1 and e2 were sequential and
    // now run at once. The set of events involved is unchanged, so only
    // a per-pair identity sees this.
    const after = step([
      { trackId: "T-a", frames: [["e1", play("vid")]] },
      {
        trackId: "T-b",
        frames: [
          ["e2", play("vid")],
          ["e3", play("vid")],
        ],
      },
    ]);

    expect(editIntroducesMediaConflict([before], [after])).toBe(true);
  });

  it("recognizes a conflict whose step an edit moved", () => {
    const existing = conflictOf("vid", "e1", "e2");
    const other = step([{ trackId: "T-x", frames: [["x1", move()]] }]);

    expect(
      editIntroducesMediaConflict([existing, other], [other, existing]),
    ).toBe(false);
  });

  it("allows two events of one video inside one batch", () => {
    // Frames within a batch run in sequence, so their order exists and
    // is editable — that is the whole point of the sub-frame form.
    const after = [
      step([
        {
          trackId: "T-video",
          frames: [
            ["cue", move()],
            ["e1", play("vid")],
            ["e2", play("vid")],
          ],
        },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("allows events of different videos in one step", () => {
    const after = [
      step([
        { trackId: "T-a", frames: [["a1", play("vid-a")]] },
        { trackId: "T-b", frames: [["b1", play("vid-b")]] },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("allows the same video's events in different steps", () => {
    const after = [
      step([{ trackId: "T-video", frames: [["e1", play("vid")]] }]),
      step([{ trackId: "T-media", frames: [["e2", play("vid")]] }]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });

  it("ignores events that name no video yet", () => {
    const after = [
      step([
        { trackId: "T-a", frames: [["e1", play()]] },
        { trackId: "T-b", frames: [["e2", play()]] },
      ]),
    ];

    expect(editIntroducesMediaConflict(empty, after)).toBe(false);
  });
});
