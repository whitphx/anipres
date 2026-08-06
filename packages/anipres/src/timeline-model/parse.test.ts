import { describe, it, expect } from "vitest";
import { parseFrameMeta } from "./parse";
import { deriveTimeline } from "./derive";
import { SYNTHETIC_STEP_PREFIX } from "./ids";

const ACTION = { type: "shapeAnimation" };

function v1Cue(globalIndex: number, action: unknown = ACTION) {
  return { id: "f1", type: "cue", globalIndex, trackId: "T", action };
}

describe("parseFrameMeta — total validation", () => {
  const malformedCues: [string, unknown][] = [
    ["NaN globalIndex", v1Cue(Number.NaN)],
    ["Infinity globalIndex", v1Cue(Number.POSITIVE_INFINITY)],
    ["fractional globalIndex", v1Cue(1.5)],
    ["negative globalIndex", v1Cue(-1)],
    ["unsafe-integer globalIndex", v1Cue(Number.MAX_SAFE_INTEGER + 2)],
    ["unknown action type", v1Cue(0, { type: "spin" })],
    ["non-numeric duration", v1Cue(0, { ...ACTION, duration: "1000" })],
    ["NaN duration", v1Cue(0, { ...ACTION, duration: Number.NaN })],
    ["Infinite duration", v1Cue(0, { ...ACTION, duration: Infinity })],
    ["unknown easing", v1Cue(0, { ...ACTION, easing: "bouncy" })],
    ["non-string easing", v1Cue(0, { ...ACTION, easing: 3 })],
    ["invalid inset", v1Cue(0, { type: "cameraZoom", inset: Number.NaN })],
    ["inset on shapeAnimation", v1Cue(0, { type: "shapeAnimation", inset: 5 })],
  ];

  it.each(malformedCues)("classifies %s as invalid", (_label, meta) => {
    expect(parseFrameMeta(meta).kind).toBe("invalid");
  });

  it("recognizes an arbitrarily large safe globalIndex as v1", () => {
    // Recognition is unbounded: any non-negative safe integer is a v1
    // index. Only the removed migration needed a ceiling (design doc r9).
    expect(parseFrameMeta(v1Cue(1_000_000)).kind).toBe("v1");
  });

  it("accepts valid actions including recognized easings and cameraZoom inset", () => {
    expect(
      parseFrameMeta({
        v: 2,
        id: "f1",
        type: "cue",
        trackId: "T",
        stepId: "s1",
        stepOrderKey: "a1",
        action: {
          type: "cameraZoom",
          duration: 500,
          easing: "easeInCubic",
          inset: 8,
        },
      }).kind,
    ).toBe("v2");
    expect(parseFrameMeta(v1Cue(3)).kind).toBe("v1");
  });

  it("applies strict action validation to v2 frames too", () => {
    expect(
      parseFrameMeta({
        v: 2,
        id: "f1",
        type: "sub",
        cueFrameId: "c1",
        orderKey: "a0",
        action: { type: "shapeAnimation", duration: Number.NaN },
      }).kind,
    ).toBe("invalid");
  });

  it("never lets malformed input make deriveTimeline throw", () => {
    const shapes = malformedCues.map(([label, meta], index) => ({
      shapeId: `shape:${index}-${label}`,
      frameMeta: meta,
    }));
    const doc = deriveTimeline({ shapes });
    expect(doc.steps).toEqual([]);
    expect(
      doc.diagnostics.filter((d) => d.type === "invalid-frame"),
    ).toHaveLength(malformedCues.length);
  });
});

describe("parseFrameMeta — reserved stepId paste mode", () => {
  const reservedCue = {
    v: 2,
    id: "f1",
    type: "cue",
    trackId: "T",
    stepId: `${SYNTHETIC_STEP_PREFIX}["s","x"]`,
    stepOrderKey: "a1",
    action: ACTION,
  };

  it("rejects persisted reserved stepIds by default", () => {
    expect(parseFrameMeta(reservedCue).kind).toBe("invalid");
  });

  it("accepts reserved stepIds only under allowReservedStepId (paste preprocessing)", () => {
    const parsed = parseFrameMeta(reservedCue, { allowReservedStepId: true });
    expect(parsed.kind).toBe("v2");
    if (parsed.kind === "v2" && parsed.frame.type === "cue") {
      expect(parsed.frame.stepId.startsWith(SYNTHETIC_STEP_PREFIX)).toBe(true);
    }
  });
});
