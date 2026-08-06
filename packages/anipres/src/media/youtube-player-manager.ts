// Per-editor registry of live YouTube IFrame API players, bridging the
// declarative side (mediaControl frames, folded playback states) to the
// imperative player API.
//
// Commands and reconciled states always update a DESIRED state first and
// reach the player only when one is ready. That closes the mount race:
// a video hidden until its appearance step registers its player *while*
// the step that plays it is running, and picks the desired state up in
// its onReady callback.

import type { Editor } from "tldraw";
import type { MediaControlFrameAction } from "../timeline-model";
import {
  applyMediaCommand,
  DEFAULT_MEDIA_VOLUME,
  INITIAL_MEDIA_PLAYBACK_STATE,
  type MediaPlaybackState,
} from "./media-state";

// Minimal typing of the pieces of the IFrame API we use.
// https://developers.google.com/youtube/iframe_api_reference
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getVolume(): number;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    element: HTMLIFrameElement,
    options: { events?: { onReady?: () => void } },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (apiPromise != null) {
    return apiPromise;
  }
  // Deferred shape (not a Promise executor): the script's error event
  // can fire SYNCHRONOUSLY on append in some environments, and the
  // failure cleanup below must see `apiPromise` already assigned or the
  // assignment would re-cache the failed promise afterwards.
  let resolve!: (yt: YTNamespace) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<YTNamespace>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  apiPromise = promise;

  if (window.YT?.Player != null) {
    resolve(window.YT);
    return promise;
  }
  const previous = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    previous?.();
    if (window.YT != null) {
      resolve(window.YT);
    }
  };
  if (document.querySelector(`script[src^="${YT_IFRAME_API_SRC}"]`) == null) {
    const script = document.createElement("script");
    script.src = YT_IFRAME_API_SRC;
    script.onerror = () => {
      // Drop both the cached failure AND the dead script element so a
      // later mount retries the load (e.g. after the network recovers)
      // — a leftover element would make the retry think a load is
      // already in flight and hang forever.
      script.remove();
      if (apiPromise === promise) {
        apiPromise = null;
      }
      reject(new Error("Failed to load the YouTube IFrame API script"));
    };
    document.head.appendChild(script);
  }
  return promise;
}

/**
 * The known state a player mounted with — what reconciliation falls
 * back to for aspects the folded event history leaves untouched. Without
 * it, rewinding before e.g. a setVolume event would leave the later
 * volume applied.
 */
export interface PlayerBaseline {
  /** The `muted` shape prop at mount. */
  muted: boolean;
  /** The `start` shape prop at mount: where a reset parks the video. */
  start: number;
  /** The player's volume captured at ready; null until then. */
  volume: number | null;
}

interface PlayerEntry {
  player: YTPlayer | null;
  disposed: boolean;
  baseline: PlayerBaseline;
}

function applyCommandToPlayer(
  player: YTPlayer,
  action: MediaControlFrameAction,
  baseline: PlayerBaseline,
): void {
  switch (action.command) {
    case "play":
      player.playVideo();
      return;
    case "pause":
      player.pauseVideo();
      return;
    case "stop":
      // Same deterministic reset the reconciler uses (see
      // applyStateToPlayer), so a live stop and a jump-past-stop land in
      // the same place.
      player.seekTo(baseline.start, true);
      player.pauseVideo();
      return;
    case "mute":
      player.mute();
      return;
    case "unmute":
      player.unMute();
      return;
    case "setVolume":
      player.setVolume(action.volume ?? DEFAULT_MEDIA_VOLUME);
      return;
  }
}

export function applyStateToPlayer(
  player: YTPlayer,
  state: MediaPlaybackState,
  baseline: PlayerBaseline,
): void {
  // Audio first so a video never starts at the wrong loudness. Aspects
  // the event history leaves untouched fall back to the baseline so
  // rewinding past an event undoes it.
  if (state.muted ?? baseline.muted) {
    player.mute();
  } else {
    player.unMute();
  }
  player.setVolume(state.volume ?? baseline.volume ?? DEFAULT_MEDIA_VOLUME);
  switch (state.status) {
    case "playing":
      player.playVideo();
      return;
    case "paused":
      player.pauseVideo();
      return;
    case "unstarted":
      // stopVideo() is documented to leave the player in "any
      // non-playing state" — not a deterministic reset. Park the video
      // paused at its configured start position instead.
      player.seekTo(baseline.start, true);
      player.pauseVideo();
      return;
  }
}

export class YouTubePlayerManager {
  private entries = new Map<string, PlayerEntry>();
  private desired = new Map<string, MediaPlaybackState>();

  private static instances = new WeakMap<Editor, YouTubePlayerManager>();
  static get(editor: Editor): YouTubePlayerManager {
    let inst = this.instances.get(editor);
    if (inst == null) {
      inst = new YouTubePlayerManager();
      this.instances.set(editor, inst);
    }
    return inst;
  }

  register(
    shapeId: string,
    iframe: HTMLIFrameElement,
    options: { muted: boolean; start: number },
  ): void {
    this.unregister(shapeId);
    const entry: PlayerEntry = {
      player: null,
      disposed: false,
      baseline: { muted: options.muted, start: options.start, volume: null },
    };
    this.entries.set(shapeId, entry);
    loadYouTubeIframeApi()
      .then((YT) => {
        if (entry.disposed || !iframe.isConnected) {
          return;
        }
        const player = new YT.Player(iframe, {
          events: {
            onReady: () => {
              if (entry.disposed) {
                return;
              }
              const volume = player.getVolume();
              if (Number.isFinite(volume)) {
                entry.baseline.volume = volume;
              }
              entry.player = player;
              const desired = this.desired.get(shapeId);
              if (desired != null) {
                applyStateToPlayer(player, desired, entry.baseline);
              }
            },
          },
        });
      })
      .catch((error) => {
        console.warn("anipres: YouTube player unavailable:", error);
      });
  }

  unregister(shapeId: string): void {
    const entry = this.entries.get(shapeId);
    if (entry == null) {
      return;
    }
    entry.disposed = true;
    // React removes the iframe on unmount before this cleanup runs, and
    // destroy() throws on a detached iframe in some browsers.
    try {
      entry.player?.destroy();
    } catch {
      // ignore
    }
    this.entries.delete(shapeId);
  }

  /**
   * Fires one command at the target shape's player (or records it for a
   * player that mounts later).
   */
  command(shapeId: string, action: MediaControlFrameAction): void {
    this.desired.set(
      shapeId,
      applyMediaCommand(
        this.desired.get(shapeId) ?? INITIAL_MEDIA_PLAYBACK_STATE,
        action,
      ),
    );
    const entry = this.entries.get(shapeId);
    if (entry?.player != null) {
      applyCommandToPlayer(entry.player, action, entry.baseline);
    }
  }

  /**
   * Forces every known player toward the given folded states; targets
   * absent from the map are reset to the initial (unstarted) state.
   */
  reconcile(states: Map<string, MediaPlaybackState>): void {
    const shapeIds = new Set([
      ...this.entries.keys(),
      ...this.desired.keys(),
      ...states.keys(),
    ]);
    for (const shapeId of shapeIds) {
      const state = states.get(shapeId) ?? INITIAL_MEDIA_PLAYBACK_STATE;
      this.desired.set(shapeId, state);
      const entry = this.entries.get(shapeId);
      if (entry?.player != null) {
        applyStateToPlayer(entry.player, state, entry.baseline);
      }
    }
  }

  /**
   * Pauses every player (e.g. on leaving presentation mode) without
   * resetting positions — kinder than a full reconcile when the user is
   * dropping back into editing.
   */
  pauseAll(): void {
    for (const [shapeId, state] of this.desired) {
      if (state.status === "playing") {
        this.desired.set(shapeId, { ...state, status: "paused" });
      }
    }
    for (const entry of this.entries.values()) {
      entry.player?.pauseVideo();
    }
  }
}
