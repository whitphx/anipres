import { describe, expect, it } from "vitest";
import { parseAgentPrompt } from "./prompt-part.js";

function promptWithBatch(batch: unknown) {
  return {
    mode: {
      type: "mode",
      modeType: "edit",
      actionTypes: [],
      partTypes: [],
    },
    userMessages: { type: "userMessages", messages: ["hi"] },
    presentationState: {
      type: "presentationState",
      totalSteps: 1,
      steps: [{ index: 0, batches: [batch] }],
    },
  };
}

describe("presentationState batch compatibility", () => {
  it("accepts the per-frame form this build sends", () => {
    const result = parseAgentPrompt(
      promptWithBatch({
        trackId: "T1",
        frames: [
          { shapeId: "shape:a", action: { type: "shapeAnimation" } },
          {
            shapeId: "shape:marker",
            targetShapeId: "shape:video",
            action: { type: "mediaControl", command: "play" },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.presentationState?.steps[0].batches[0]).toEqual({
      trackId: "T1",
      frames: [
        { shapeId: "shape:a", action: { type: "shapeAnimation" } },
        {
          shapeId: "shape:marker",
          targetShapeId: "shape:video",
          action: { type: "mediaControl", command: "play" },
        },
      ],
    });
  });

  it("normalizes the form a bundle cached from before this build sends", () => {
    // Without this the request would fail parsing outright, taking the
    // agent down for every tab still running the previous bundle.
    const result = parseAgentPrompt(
      promptWithBatch({
        trackId: "T1",
        shapeIds: ["shape:a", "shape:b"],
        frameAction: { type: "shapeAnimation", duration: 500 },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.presentationState?.steps[0].batches[0]).toEqual({
      trackId: "T1",
      frames: [
        {
          shapeId: "shape:a",
          action: { type: "shapeAnimation", duration: 500 },
        },
        {
          shapeId: "shape:b",
          action: { type: "shapeAnimation", duration: 500 },
        },
      ],
    });
  });

  it("rejects a batch in neither form", () => {
    expect(parseAgentPrompt(promptWithBatch({ trackId: "T1" })).success).toBe(
      false,
    );
  });
});
