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
    getIframe: () => document.createElement("iframe"),
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
    // NOTE: this leaves the module-level cache resolved, so nothing
    // below may use the statically imported loader — the tests that
    // follow import fresh module instances.
    const yt = { Player: class {} } as unknown as NonNullable<typeof window.YT>;
    window.YT = yt;
    await expect(loadYouTubeIframeApi()).resolves.toBe(yt);
  });

  // The tests below exercise the pre-existing-script-tag path (a tag
  // the host page inserted before us). Each imports a fresh module so
  // the cached promise cannot leak between them or into the test above.
  async function freshLoader() {
    vi.resetModules();
    const mod = await import("./youtube-player-manager");
    return mod.loadYouTubeIframeApi;
  }

  function insertForeignApiScript() {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
    return script;
  }

  it("recovers when a pre-existing script tag errors after the call", async () => {
    const load = await freshLoader();
    const script = insertForeignApiScript();

    const first = load();
    script.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow(
      "Failed to load the YouTube IFrame API script",
    );
    // The dead tag is gone, so a retry creates a fresh one instead of
    // waiting forever on the corpse. (In happy-dom the fresh tag may
    // error synchronously on append, so the rejection expectation is
    // attached before poking it.)
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
    const second = load();
    const secondRejection = expect(second).rejects.toThrow();
    expect(second).not.toBe(first);
    document.querySelector(SCRIPT_SELECTOR)?.dispatchEvent(new Event("error"));
    await secondRejection;
  });

  it("times out on a pre-existing script tag that never becomes ready", async () => {
    // A tag whose error event fired BEFORE the call is undetectable
    // after the fact; the readiness timeout is the only way out.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = await freshLoader();
      const script = insertForeignApiScript();

      const promise = load();
      const rejection = expect(promise).rejects.toThrow(
        "Timed out waiting for the YouTube IFrame API to become ready",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      // The host page owns this tag and a timeout does not prove it
      // dead (it may just be slow), so it is left in place; a retry
      // re-arms the watch on it instead of hanging.
      expect(document.querySelector(SCRIPT_SELECTOR)).toBe(script);
      const second = load();
      expect(second).not.toBe(promise);
      const secondRejection = expect(second).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);
      await secondRejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves through a pre-existing script tag's ready callback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const load = await freshLoader();
      const script = insertForeignApiScript();

      const promise = load();
      const yt = {
        Player: class {},
      } as unknown as NonNullable<typeof window.YT>;
      window.YT = yt;
      window.onYouTubeIframeAPIReady?.();
      await expect(promise).resolves.toBe(yt);
      // The readiness watch is torn down: the timeout must not fire
      // later and remove the live tag.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(document.querySelector(SCRIPT_SELECTOR)).toBe(script);
    } finally {
      vi.useRealTimers();
    }
  });

  // Nested here for the describe's afterEach cleanup (window.YT, the
  // script tag): these exercise register()'s retry loop, which drives
  // the loader through the same fresh-module discipline.
  describe("register retry", () => {
    async function freshManager() {
      vi.resetModules();
      const mod = await import("./youtube-player-manager");
      return new mod.YouTubePlayerManager();
    }

    function mountHost() {
      const host = document.createElement("div");
      document.body.appendChild(host);
      return host;
    }

    const REGISTER_OPTIONS = {
      videoId: "M7lc1UVf-VE",
      muted: false,
      start: 0,
      controls: true,
      title: "",
    };

    it("retries mounting a registered player after a transient API failure", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const host = mountHost();
      try {
        const manager = await freshManager();
        const constructions: unknown[] = [];
        class StubPlayer {
          constructor(el: unknown) {
            constructions.push(el);
          }
          destroy() {}
        }

        // First attempt fails: no API, and happy-dom errors the
        // loader's script synchronously on append.
        manager.register("shape:v", host, REGISTER_OPTIONS);
        await vi.advanceTimersByTimeAsync(0);
        expect(constructions).toHaveLength(0);

        // The network recovers before the retry fires.
        window.YT = { Player: StubPlayer } as unknown as NonNullable<
          typeof window.YT
        >;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(constructions).toEqual([host]);

        manager.unregister("shape:v");
      } finally {
        host.remove();
        vi.useRealTimers();
      }
    });

    it("rebuilds a player whose ready handshake never completes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const container = mountHost();
      const host = document.createElement("div");
      container.appendChild(host);
      try {
        const manager = await freshManager();
        const destroyed: unknown[] = [];
        const constructedOn: unknown[] = [];
        const constructedUnder: unknown[] = [];
        // Never calls onReady, and replaces its host element the way
        // the real API does — so a retry has nowhere to mount unless a
        // fresh host is created.
        class StallingPlayer {
          private el: HTMLElement;
          constructor(el: HTMLElement) {
            this.el = el;
            constructedOn.push(el);
            constructedUnder.push(el.parentElement);
            const iframe = document.createElement("iframe");
            el.replaceWith(iframe);
            this.el = iframe;
          }
          destroy() {
            destroyed.push(this.el);
            this.el.remove();
          }
        }
        window.YT = { Player: StallingPlayer } as unknown as NonNullable<
          typeof window.YT
        >;

        manager.register("shape:v", host, REGISTER_OPTIONS);
        await vi.advanceTimersByTimeAsync(0);
        expect(constructedOn).toEqual([host]);

        // The handshake deadline expires, then the retry backoff.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(destroyed).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(constructedOn).toHaveLength(2);
        expect(constructedOn[1]).not.toBe(host);
        // The fresh host lands where the caller's host was.
        expect(constructedUnder[1]).toBe(container);

        manager.unregister("shape:v");
        // Unregister clears both timers: no further rebuilds.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(constructedOn).toHaveLength(2);
      } finally {
        container.remove();
        vi.useRealTimers();
      }
    });

    it("stops retrying a failed mount once the shape unregisters", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const host = mountHost();
      try {
        const manager = await freshManager();
        const constructions: unknown[] = [];
        class StubPlayer {
          constructor(el: unknown) {
            constructions.push(el);
          }
          destroy() {}
        }

        manager.register("shape:v", host, REGISTER_OPTIONS);
        await vi.advanceTimersByTimeAsync(0);
        manager.unregister("shape:v");

        window.YT = { Player: StubPlayer } as unknown as NonNullable<
          typeof window.YT
        >;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(constructions).toHaveLength(0);
      } finally {
        host.remove();
        vi.useRealTimers();
      }
    });
  });
});
