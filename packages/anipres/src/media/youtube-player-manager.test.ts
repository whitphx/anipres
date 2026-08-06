/** @vitest-environment happy-dom */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  applyStateToPlayer,
  loadYouTubeIframeApi,
  type YTPlayer,
} from "./youtube-player-manager";
import { INITIAL_MEDIA_PLAYBACK_STATE } from "./media-state";

const YT_STATE_PLAYING = 1;
const YT_STATE_CUED = 5;

function makeFakePlayer(
  playerState = YT_STATE_PLAYING,
): YTPlayer & { calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  return {
    calls,
    playVideo: () => calls.push(["playVideo"]),
    pauseVideo: () => calls.push(["pauseVideo"]),
    seekTo: (seconds, allowSeekAhead) =>
      calls.push(["seekTo", seconds, allowSeekAhead]),
    mute: () => calls.push(["mute"]),
    unMute: () => calls.push(["unMute"]),
    setVolume: (volume) => calls.push(["setVolume", volume]),
    getVolume: () => 100,
    getPlayerState: () => playerState,
    destroy: () => calls.push(["destroy"]),
  };
}

describe("applyStateToPlayer", () => {
  it("resets untouched aspects to the baseline (rewind past events)", () => {
    const player = makeFakePlayer();
    applyStateToPlayer(player, INITIAL_MEDIA_PLAYBACK_STATE, {
      muted: false,
      start: 7,
      volume: 40,
    });
    // Not stopVideo(): the API documents it may leave the player in any
    // non-playing state, so the reset parks the video paused at start.
    expect(player.calls).toEqual([
      ["unMute"],
      ["setVolume", 40],
      ["seekTo", 7, true],
      ["pauseVideo"],
    ]);
  });

  it("does not seek a cued player (seekTo would start playback)", () => {
    const player = makeFakePlayer(YT_STATE_CUED);
    applyStateToPlayer(player, INITIAL_MEDIA_PLAYBACK_STATE, {
      muted: false,
      start: 7,
      volume: 40,
    });
    expect(player.calls).toEqual([["unMute"], ["setVolume", 40]]);
  });

  it("prefers the folded state over the baseline", () => {
    const player = makeFakePlayer();
    applyStateToPlayer(
      player,
      { status: "playing", muted: true, volume: 20 },
      { muted: false, start: 0, volume: 40 },
    );
    expect(player.calls).toEqual([["mute"], ["setVolume", 20], ["playVideo"]]);
  });

  it("falls back to the default volume before the baseline is captured", () => {
    const player = makeFakePlayer();
    applyStateToPlayer(
      player,
      { status: "paused", muted: null, volume: null },
      { muted: true, start: 0, volume: null },
    );
    expect(player.calls).toEqual([
      ["mute"],
      ["setVolume", 100],
      ["pauseVideo"],
    ]);
  });
});

describe("loadYouTubeIframeApi", () => {
  const SCRIPT_SELECTOR = 'script[src^="https://www.youtube.com/iframe_api"]';

  afterEach(() => {
    delete window.YT;
    window.onYouTubeIframeAPIReady = undefined;
    document.querySelector(SCRIPT_SELECTOR)?.remove();
  });

  // In this environment the appended script fails to load on its own
  // (happy-dom fires the error event during append); firing a manual
  // error only when the element is still around keeps the test robust
  // either way.
  function failPendingScriptLoad() {
    document.querySelector(SCRIPT_SELECTOR)?.dispatchEvent(new Event("error"));
  }

  it("retries after a load failure instead of hanging on the dead script", async () => {
    const createdScripts = vi.spyOn(document, "createElement");

    const first = loadYouTubeIframeApi();
    failPendingScriptLoad();
    await expect(first).rejects.toThrow();
    // The dead element must be gone, or the retry below would think a
    // load is already in flight and never settle.
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();

    const second = loadYouTubeIframeApi();
    expect(second).not.toBe(first);
    failPendingScriptLoad();
    await expect(second).rejects.toThrow();
    expect(
      createdScripts.mock.calls.filter(([tag]) => tag === "script"),
    ).toHaveLength(2);
    createdScripts.mockRestore();

    // Once the API is reachable (here: already present), loading works.
    // NOTE: this leaves the module-level cache resolved, so this must
    // stay the file's last loader interaction.
    const yt = { Player: class {} } as unknown as NonNullable<typeof window.YT>;
    window.YT = yt;
    await expect(loadYouTubeIframeApi()).resolves.toBe(yt);
  });
});
