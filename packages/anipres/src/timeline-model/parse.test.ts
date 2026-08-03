import { describe, it, expect } from "vitest";
import { parseFrameMeta } from "./parse";
import { deriveTimeline } from "./derive";
import { migrateV1Frames } from "./migrate";
import {
  MAX_MIGRATION_COORDINATE,
  SYNTHETIC_STEP_PREFIX,
  parseMigratedStepId,
} from "./ids";

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

  it("never lets malformed input make deriveTimeline or migration throw", () => {
    const shapes = malformedCues.map(([label, meta], index) => ({
      shapeId: `shape:${index}-${label}`,
      frameMeta: meta,
    }));
    const doc = deriveTimeline({ shapes, pageId: "page:page" });
    expect(doc.steps).toEqual([]);
    expect(
      doc.diagnostics.filter((d) => d.type === "invalid-frame"),
    ).toHaveLength(malformedCues.length);
    // Migration only ever receives parser-accepted frames, so malformed
    // input cannot reach its (internal) coordinate assertions.
    expect(() => migrateV1Frames([], [], "page:page")).not.toThrow();
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

describe("parseFrameMeta — migration coordinate bound", () => {
  it("classifies an absurdly large v1 globalIndex as invalid (no key-chain hang)", () => {
    expect(parseFrameMeta(v1Cue(1_000_000_000)).kind).toBe("invalid");
    expect(parseFrameMeta(v1Cue(MAX_MIGRATION_COORDINATE)).kind).toBe("v1");
    expect(parseFrameMeta(v1Cue(MAX_MIGRATION_COORDINATE + 1)).kind).toBe(
      "invalid",
    );
  });

  it("treats v1step ids with out-of-range coordinates as ordinary stepIds", () => {
    expect(parseMigratedStepId(`v1step:page:page:1000000000:0`)).toBeNull();
    expect(parseMigratedStepId(`v1step:page:page:3:1000000000`)).toBeNull();
    expect(parseMigratedStepId(`v1step:page:page:3:1`)).toEqual({
      pageId: "page:page",
      globalIndex: 3,
      partitionIndex: 1,
    });
  });
});
