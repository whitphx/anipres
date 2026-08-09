import { describe, it, expect } from "vitest";
import type { RuntimeStep } from "../timeline-model/runtime-steps";
import type { MediaControlFrameAction } from "../timeline-model";
import {
  applyMediaCommand,
  foldMediaPlaybackStates,
  INITIAL_MEDIA_PLAYBACK_STATE,
} from "./media-state";

function mediaStep(
  entries: [markerShapeId: string, action: MediaControlFrameAction][],
): RuntimeStep {
  return entries.map(([shapeId, action], i) => ({
    id: `batch-${shapeId}`,
    trackId: `track-${i}`,
    stepIndex: 0,
    data: [{ id: `f-${shapeId}`, shapeId, type: "cue" as const, action }],
  }));
}

const resolve = (markerShapeId: string) =>
  markerShapeId.startsWith("orphan") ? null : `video-of-${markerShapeId}`;

describe("applyMediaCommand", () => {
  it("keeps audio settings across play/pause/stop", () => {
    let state = INITIAL_MEDIA_PLAYBACK_STATE;
    state = applyMediaCommand(state, { type: "mediaControl", command: "mute" });
    state = applyMediaCommand(state, {
      type: "mediaControl",
      command: "setVolume",
      volume: 30,
    });
    state = applyMediaCommand(state, { type: "mediaControl", command: "play" });
    expect(state).toEqual({ status: "playing", muted: true, volume: 30 });
    state = applyMediaCommand(state, { type: "mediaControl", command: "stop" });
    expect(state).toEqual({ status: "unstarted", muted: true, volume: 30 });
  });

  it("defaults setVolume without an explicit volume to 100", () => {
    expect(
      applyMediaCommand(INITIAL_MEDIA_PLAYBACK_STATE, {
        type: "mediaControl",
        command: "setVolume",
      }).volume,
    ).toBe(100);
  });
});

describe("foldMediaPlaybackStates", () => {
  const steps: RuntimeStep[] = [
    mediaStep([["m1", { type: "mediaControl", command: "play" }]]),
    mediaStep([
      ["m2", { type: "mediaControl", command: "mute" }],
      ["other1", { type: "mediaControl", command: "play" }],
    ]),
    mediaStep([["m3", { type: "mediaControl", command: "pause" }]]),
  ];
  // m1/m2/m3 all target the same video via the resolver below.
  const resolveSame = (id: string) =>
    id.startsWith("m") ? "video-a" : "video-b";

  it("folds only steps up to the given index", () => {
    expect(foldMediaPlaybackStates(steps, 0, resolveSame)).toEqual(
      new Map([["video-a", { status: "playing", muted: null, volume: null }]]),
    );
    expect(foldMediaPlaybackStates(steps, 2, resolveSame)).toEqual(
      new Map([
        ["video-a", { status: "paused", muted: true, volume: null }],
        ["video-b", { status: "playing", muted: null, volume: null }],
      ]),
    );
  });

  it("returns an empty map before any media step", () => {
    expect(foldMediaPlaybackStates(steps, -1, resolveSame).size).toBe(0);
  });

  it("skips frames whose target cannot be resolved", () => {
    const orphanSteps = [
      mediaStep([["orphan1", { type: "mediaControl", command: "play" }]]),
    ];
    expect(foldMediaPlaybackStates(orphanSteps, 0, resolve).size).toBe(0);
  });

  it("ignores non-media actions", () => {
    const mixed: RuntimeStep[] = [
      [
        {
          id: "b",
          trackId: "t",
          stepIndex: 0,
          data: [
            {
              id: "f",
              shapeId: "s",
              type: "cue",
              action: { type: "shapeAnimation" },
            },
          ],
        },
      ],
    ];
    expect(foldMediaPlaybackStates(mixed, 0, () => "video").size).toBe(0);
  });
});
