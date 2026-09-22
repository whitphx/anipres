import { describe, it, expect } from "vitest";
import { DEFAULT_MEDIA_VOLUME } from "../../media/media-state";
import { withCommand } from "./media-command";

describe("withCommand", () => {
  it("keeps the event pointed at the same video", () => {
    expect(
      withCommand(
        { type: "mediaControl", command: "play", videoKey: "shape:video" },
        "pause",
      ),
    ).toEqual({
      type: "mediaControl",
      command: "pause",
      videoKey: "shape:video",
    });
  });

  it("adds a volume for setVolume and strips it again", () => {
    const withVolume = withCommand(
      { type: "mediaControl", command: "play", videoKey: "shape:video" },
      "setVolume",
    );
    expect(withVolume.volume).toBe(DEFAULT_MEDIA_VOLUME);
    expect(withCommand(withVolume, "mute")).toEqual({
      type: "mediaControl",
      command: "mute",
      videoKey: "shape:video",
    });
  });

  it("carries the wait that follows the command", () => {
    expect(
      withCommand(
        { type: "mediaControl", command: "play", duration: 250 },
        "stop",
      ).duration,
    ).toBe(250);
  });
});
