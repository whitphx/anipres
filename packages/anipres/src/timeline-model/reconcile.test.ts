import { describe, it, expect } from "vitest";
import { reconcileEditedSteps } from "./reconcile";
import type { CueFrame, EditedStep, Frame, SubFrame } from "./types";

function cue(
  id: string,
  stepId: string,
  stepOrderKey: string,
  trackId: string,
): CueFrame {
  return {
    v: 2,
    id,
    type: "cue",
    trackId,
    stepId,
    stepOrderKey,
    action: { type: "shapeAnimation" },
  };
}
function sub(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return {
    v: 2,
    id,
    type: "sub",
    cueFrameId,
    orderKey,
    action: { type: "shapeAnimation" },
  };
}

function makeMinter() {
  let n = 0;
  return () => `minted-${++n}`;
}

const ACTION = { type: "shapeAnimation" as const };

describe("reconcileEditedSteps", () => {
  const currentFrames: { shapeId: string; frame: Frame }[] = [
    { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
    { shapeId: "shape:b", frame: cue("f2", "s2", "a2", "U") },
    { shapeId: "shape:c", frame: sub("f3", "f2", "a0") },
    { shapeId: "shape:d", frame: cue("f4", "s3", "a3", "T") },
  ];
  const unchanged: EditedStep[] = [
    [
      {
        trackId: "T",
        frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
      },
    ],
    [
      {
        trackId: "U",
        frames: [
          { shapeId: "shape:b", frameId: "f2", action: ACTION },
          { shapeId: "shape:c", frameId: "f3", action: ACTION },
        ],
      },
    ],
    [
      {
        trackId: "T",
        frames: [{ shapeId: "shape:d", frameId: "f4", action: ACTION }],
      },
    ],
  ];

  it("produces zero writes for an unchanged timeline", () => {
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: unchanged,
      mintId: makeMinter(),
    });
    expect(result.updates).toEqual([]);
    expect(result.removedShapeIds).toEqual([]);
  });

  it("moving one batch to another step writes only that batch's frames", () => {
    // Move f4's batch into step 2 (joins s2).
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
        },
      ],
      [
        {
          trackId: "U",
          frames: [
            { shapeId: "shape:b", frameId: "f2", action: ACTION },
            { shapeId: "shape:c", frameId: "f3", action: ACTION },
          ],
        },
        {
          trackId: "T",
          frames: [{ shapeId: "shape:d", frameId: "f4", action: ACTION }],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].shapeId).toBe("shape:d");
    const moved = result.updates[0].frame as CueFrame;
    expect(moved.stepId).toBe("s2"); // joined the target step
    expect(moved.stepOrderKey).toBe("a2"); // copied the target's key
  });

  it("inserting a new step between steps keeps every existing frame untouched", () => {
    // f4 is pulled out into its own new step between s1 and s2.
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
        },
      ],
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:d", frameId: "f4", action: ACTION }],
        },
      ],
      [
        {
          trackId: "U",
          frames: [
            { shapeId: "shape:b", frameId: "f2", action: ACTION },
            { shapeId: "shape:c", frameId: "f3", action: ACTION },
          ],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    expect(result.updates).toHaveLength(1);
    const moved = result.updates[0].frame as CueFrame;
    expect(result.updates[0].shapeId).toBe("shape:d");
    expect(moved.stepId).toBe("s3"); // keeps its stable identity
    expect(moved.stepOrderKey > "a1" && moved.stepOrderKey < "a2").toBe(true);
  });

  it("converts a cue to a sub frame when merged into another batch", () => {
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [
            { shapeId: "shape:a", frameId: "f1", action: ACTION },
            { shapeId: "shape:d", frameId: "f4", action: ACTION }, // was a cue, becomes a sub
          ],
        },
      ],
      [
        {
          trackId: "U",
          frames: [
            { shapeId: "shape:b", frameId: "f2", action: ACTION },
            { shapeId: "shape:c", frameId: "f3", action: ACTION },
          ],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    const update = result.updates.find((u) => u.shapeId === "shape:d");
    expect(update?.frame).toMatchObject({
      type: "sub",
      cueFrameId: "f1",
    });
  });

  it("removes frames absent from the edited structure", () => {
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    expect(result.removedShapeIds).toEqual(["shape:b", "shape:c", "shape:d"]);
  });

  it("mints a fresh stepId when a step splits (identity can't be claimed twice)", () => {
    // s2's batch splits: f2 stays, f3 becomes its own new cue/step.
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
        },
      ],
      [
        {
          trackId: "U",
          frames: [{ shapeId: "shape:b", frameId: "f2", action: ACTION }],
        },
      ],
      [
        {
          trackId: "U",
          frames: [{ shapeId: "shape:c", frameId: "f3", action: ACTION }],
        },
      ],
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:d", frameId: "f4", action: ACTION }],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    const f3Update = result.updates.find((u) => u.shapeId === "shape:c");
    const promoted = f3Update?.frame as CueFrame;
    expect(promoted.type).toBe("cue");
    expect(promoted.stepId).toBe("minted-1");
    expect(promoted.stepOrderKey > "a2" && promoted.stepOrderKey < "a3").toBe(
      true,
    );
    // f1, f2, f4 untouched.
    expect(result.updates.map((u) => u.shapeId).sort()).toEqual(["shape:c"]);
  });

  it("reordering steps rewrites only the moved step's cue frames", () => {
    // Move s3 before s2.
    const edited: EditedStep[] = [
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
        },
      ],
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:d", frameId: "f4", action: ACTION }],
        },
      ],
      [
        {
          trackId: "U",
          frames: [
            { shapeId: "shape:b", frameId: "f2", action: ACTION },
            { shapeId: "shape:c", frameId: "f3", action: ACTION },
          ],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:d"]);
  });
});

// Regression: identity in the edit pipeline is the SHAPE id. Keying by
// frame id would collapse duplicate frame ids (kept lossless by
// derivation rule 4) onto one representative, and an unrelated move could
// strip the other shape's animation metadata.
describe("duplicate frame ids in the edit pipeline", () => {
  it("keeps both shapes' metadata and updates them independently", () => {
    const frames = [
      { shapeId: "shape:a", frame: cue("dup", "s1", "a1", "T") },
      { shapeId: "shape:b", frame: cue("dup", "s2", "a2", "U") },
    ];
    // Move shape:b's step before shape:a's.
    const edited: EditedStep[] = [
      [
        {
          trackId: "U",
          frames: [{ shapeId: "shape:b", frameId: "dup", action: ACTION }],
        },
      ],
      [
        {
          trackId: "T",
          frames: [{ shapeId: "shape:a", frameId: "dup", action: ACTION }],
        },
      ],
    ];
    const result = reconcileEditedSteps({
      currentFrames: frames,
      editedSteps: edited,
      mintId: makeMinter(),
    });
    // Neither shape loses its metadata...
    expect(result.removedShapeIds).toEqual([]);
    // ...and only the moved shape is rewritten, keeping its stored id.
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:b"]);
    const moved = result.updates[0].frame as CueFrame;
    expect(moved.id).toBe("dup");
    expect(moved.stepOrderKey < "a1").toBe(true);
  });
});
