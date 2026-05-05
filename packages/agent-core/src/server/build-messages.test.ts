import { describe, expect, it } from "vitest";
import { buildMessages } from "./build-messages.js";
import type { AgentPrompt } from "../schemas/parts.js";

const baseMode: AgentPrompt["mode"] = {
  type: "mode",
  modeType: "default",
  actionTypes: [],
  partTypes: [],
};

describe("buildMessages", () => {
  it("includes pageShapes, presentationState, and userMessages when present", () => {
    const prompt: AgentPrompt = {
      mode: baseMode,
      pageShapes: {
        type: "pageShapes",
        shapes: [
          {
            _type: "rectangle",
            shapeId: "shape:r1",
            x: 0,
            y: 0,
            w: 100,
            h: 60,
            color: "black",
            text: "",
          },
        ],
      },
      presentationState: {
        type: "presentationState",
        totalSteps: 1,
        steps: [
          {
            index: 0,
            batches: [
              {
                trackId: "track-A",
                shapeIds: ["shape:slide1"],
                frameAction: { type: "cameraZoom", duration: 0 },
              },
            ],
          },
        ],
      },
      userMessages: {
        type: "userMessages",
        messages: ["add an 8th slide"],
      },
    };

    const out = buildMessages(prompt);
    expect(out).toHaveLength(1);
    const content = out[0].content as string;
    expect(content).toContain("## Current canvas");
    expect(content).toContain("## Presentation state");
    expect(content).toContain("## User");
    expect(content).toContain("totalSteps");
    expect(content).toContain("track-A");
    expect(content).toContain("add an 8th slide");
  });

  it("omits empty parts", () => {
    const prompt: AgentPrompt = {
      mode: baseMode,
      userMessages: { type: "userMessages", messages: ["hi"] },
    };
    const content = buildMessages(prompt)[0].content as string;
    expect(content).not.toContain("## Current canvas");
    expect(content).not.toContain("## Presentation state");
    expect(content).toContain("hi");
  });
});
