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
  getPlayerState(): number;
  getIframe(): HTMLIFrameElement;
  destroy(): void;
}

// YT.PlayerState values (numeric; the enum object lives on the loaded
// namespace, which pure helpers below don't have).
const YT_PLAYER_STATE_UNSTARTED = -1;
const YT_PLAYER_STATE_CUED = 5;
interface YTNamespace {
  Player: new (
    // The API REPLACES this element with an iframe it creates and owns.
    element: HTMLElement,
    options: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: { onReady?: () => void };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YT_IFRAME_API_SRC = "https://www.youtube.com/iframe_api";

// A false timeout costs a wasted load cycle before register()'s retry
// re-arms it; a true positive only waits this long before the retry.
const API_READY_TIMEOUT_MS = 30_000;

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
  const existingScript = document.querySelector<HTMLScriptElement>(
    `script[src^="${YT_IFRAME_API_SRC}"]`,
  );
  const ownScript = existingScript == null;
  const script = existingScript ?? document.createElement("script");

  // The watch covers both failure modes a ready-callback alone misses:
  // the script erroring (possibly BEFORE this call for a tag the host
  // page inserted, which nothing can detect after the fact — hence the
  // timeout), and the host page overwriting onYouTubeIframeAPIReady
  // after us, in which case our callback never fires even though the
  // script loaded.
  const onError = () => {
    // A fired error event proves the tag is dead; removing it lets the
    // retry create a fresh one instead of finding the corpse.
    fail("Failed to load the YouTube IFrame API script", true);
  };
  // Closure-forward reference to `timer`: the watch is only cancelled
  // after it is armed below.
  const cancelWatch = () => {
    clearTimeout(timer);
    script.removeEventListener("error", onError);
  };
  // Restoring the previous ready-callback keeps repeated failures from
  // stacking wrappers; clearing the cached promise lets a later mount
  // retry (e.g. after the network recovers).
  const fail = (message: string, removeScript: boolean) => {
    cancelWatch();
    if (removeScript) {
      script.remove();
    }
    window.onYouTubeIframeAPIReady = previous;
    if (apiPromise === promise) {
      apiPromise = null;
    }
    reject(new Error(message));
  };

  window.onYouTubeIframeAPIReady = () => {
    try {
      previous?.();
    } finally {
      if (window.YT != null) {
        cancelWatch();
        resolve(window.YT);
      }
    }
  };
  script.addEventListener("error", onError);
  const timer = setTimeout(() => {
    // A timeout does not prove the tag is dead (it may just be slow),
    // so a tag the host page owns is left in place — the retry re-arms
    // this watch on it rather than hanging. Our own tag is removed: if
    // its load does complete later, the restored ready-callback still
    // runs, and the fresh promise starts clean either way.
    fail(
      "Timed out waiting for the YouTube IFrame API to become ready",
      ownScript,
    );
  }, API_READY_TIMEOUT_MS);
  if (ownScript) {
    script.src = YT_IFRAME_API_SRC;
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
  /** Ready to receive commands (set in onReady). */
  player: YTPlayer | null;
  /** Constructed but not yet ready — tracked so unregister can destroy
   * it; commands keep gating on `player`. */
  pendingPlayer: YTPlayer | null;
  /** Armed after an API load failure; cleared by unregister. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  baseline: PlayerBaseline;
}

// Capped backoff for retrying the API load while a video stays
// mounted: without it a transient failure (offline at first mount)
// leaves the embed blank until the shape happens to remount. Attempts
// continue at the cap indefinitely — one timer per mounted video.
const PLAYER_MOUNT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

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
      // Same deterministic reset the reconciler uses, so a live stop
      // and a jump-past-stop land in the same place.
      resetPlayerToStart(player, baseline);
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

/**
 * Parks the player paused at its configured start. stopVideo() is
 * documented to leave the player in "any non-playing state" — not a
 * deterministic reset — hence seek + pause instead.
 */
function resetPlayerToStart(player: YTPlayer, baseline: PlayerBaseline): void {
  const playerState = player.getPlayerState();
  if (
    playerState === YT_PLAYER_STATE_UNSTARTED ||
    playerState === YT_PLAYER_STATE_CUED
  ) {
    // Already parked — and seekTo on a cued/unstarted player is
    // documented to START playback, so touching it would blip audio and
    // eagerly load the stream.
    return;
  }
  player.seekTo(baseline.start, true);
  player.pauseVideo();
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
      resetPlayerToStart(player, baseline);
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

  /**
   * Creates a player inside `host` (which the IFrame API replaces with
   * an iframe it creates and owns). The caller must keep that iframe
   * OUT of React's virtual DOM — a React-rendered iframe and the widget
   * API fight over the element's attributes, endlessly reloading the
   * embed. Constructing from a placeholder element is the API's
   * documented usage (reference linked at the top of this file);
   * keeping that element out of React's rendering entirely comes from
   * react-youtube (MIT):
   * https://github.com/tjallingt/react-youtube/blob/master/packages/react-youtube/src/YouTube.tsx
   */
  register(
    shapeId: string,
    host: HTMLElement,
    options: {
      videoId: string;
      muted: boolean;
      start: number;
      controls: boolean;
      title: string;
    },
  ): void {
    this.unregister(shapeId);
    const entry: PlayerEntry = {
      player: null,
      pendingPlayer: null,
      retryTimer: null,
      disposed: false,
      baseline: { muted: options.muted, start: options.start, volume: null },
    };
    this.entries.set(shapeId, entry);
    const attemptMount = (attempt: number) => {
      loadYouTubeIframeApi()
        .then((YT) => {
          if (entry.disposed || !host.isConnected) {
            return;
          }
          const player = new YT.Player(host, {
            videoId: options.videoId,
            width: "100%",
            height: "100%",
            // Privacy-enhanced host; the API adds enablejsapi/origin
            // itself.
            host: "https://www.youtube-nocookie.com",
            playerVars: {
              playsinline: 1,
              rel: 0,
              ...(options.start > 0
                ? { start: Math.floor(options.start) }
                : {}),
              ...(options.muted ? { mute: 1 } : {}),
              ...(options.controls ? {} : { controls: 0 }),
            },
            events: {
              onReady: () => {
                if (entry.disposed) {
                  return;
                }
                entry.pendingPlayer = null;
                const volume = player.getVolume();
                if (Number.isFinite(volume)) {
                  entry.baseline.volume = volume;
                }
                if (options.title !== "") {
                  try {
                    player.getIframe().title = options.title;
                  } catch {
                    // ignore
                  }
                }
                entry.player = player;
                const desired = this.desired.get(shapeId);
                if (desired != null) {
                  applyStateToPlayer(player, desired, entry.baseline);
                }
              },
            },
          });
          entry.pendingPlayer = player;
        })
        .catch((error) => {
          // Once, not per attempt: at the capped delay a permanently
          // blocked API (ad blocker, CSP) would otherwise warn forever.
          if (attempt === 0) {
            console.warn(
              "anipres: YouTube player unavailable, retrying while mounted:",
              error,
            );
          }
          if (entry.disposed || !host.isConnected) {
            return;
          }
          const delay =
            PLAYER_MOUNT_RETRY_DELAYS_MS[
              Math.min(attempt, PLAYER_MOUNT_RETRY_DELAYS_MS.length - 1)
            ];
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            if (entry.disposed || !host.isConnected) {
              return;
            }
            attemptMount(attempt + 1);
          }, delay);
        });
    };
    attemptMount(0);
  }

  unregister(shapeId: string): void {
    const entry = this.entries.get(shapeId);
    if (entry == null) {
      return;
    }
    entry.disposed = true;
    if (entry.retryTimer != null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    // On shape unmount the container (with the API's iframe inside) is
    // already detached when this cleanup runs, and destroy() throws on
    // a detached iframe in some browsers. A pending (not-yet-ready)
    // player must be destroyed too, or its postMessage plumbing keeps
    // running against the removed iframe.
    try {
      (entry.player ?? entry.pendingPlayer)?.destroy();
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
