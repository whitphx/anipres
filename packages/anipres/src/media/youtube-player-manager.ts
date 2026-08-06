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
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
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
function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (apiPromise == null) {
    apiPromise = new Promise<YTNamespace>((resolve) => {
      if (window.YT?.Player != null) {
        resolve(window.YT);
        return;
      }
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        if (window.YT != null) {
          resolve(window.YT);
        }
      };
      if (
        document.querySelector(`script[src^="${YT_IFRAME_API_SRC}"]`) == null
      ) {
        const script = document.createElement("script");
        script.src = YT_IFRAME_API_SRC;
        document.head.appendChild(script);
      }
    });
  }
  return apiPromise;
}

export interface MediaPlayerDefaults {
  /** The muted state the player mounted with (`muted` shape prop). */
  muted: boolean;
}

interface PlayerEntry {
  player: YTPlayer | null;
  disposed: boolean;
  defaults: MediaPlayerDefaults;
}

function applyCommandToPlayer(
  player: YTPlayer,
  action: MediaControlFrameAction,
): void {
  switch (action.command) {
    case "play":
      player.playVideo();
      return;
    case "pause":
      player.pauseVideo();
      return;
    case "stop":
      player.stopVideo();
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

function applyStateToPlayer(
  player: YTPlayer,
  state: MediaPlaybackState,
  defaults: MediaPlayerDefaults,
): void {
  // Audio first so a video never starts at the wrong loudness.
  if (state.muted ?? defaults.muted) {
    player.mute();
  } else {
    player.unMute();
  }
  if (state.volume != null) {
    player.setVolume(state.volume);
  }
  switch (state.status) {
    case "playing":
      player.playVideo();
      return;
    case "paused":
      player.pauseVideo();
      return;
    case "unstarted":
      player.stopVideo();
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
    defaults: MediaPlayerDefaults,
  ): void {
    this.unregister(shapeId);
    const entry: PlayerEntry = { player: null, disposed: false, defaults };
    this.entries.set(shapeId, entry);
    loadYouTubeIframeApi().then((YT) => {
      if (entry.disposed || !iframe.isConnected) {
        return;
      }
      const player = new YT.Player(iframe, {
        events: {
          onReady: () => {
            if (entry.disposed) {
              return;
            }
            entry.player = player;
            const desired = this.desired.get(shapeId);
            if (desired != null) {
              applyStateToPlayer(player, desired, entry.defaults);
            }
          },
        },
      });
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
    const player = this.entries.get(shapeId)?.player;
    if (player != null) {
      applyCommandToPlayer(player, action);
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
        applyStateToPlayer(entry.player, state, entry.defaults);
      }
    }
  }
}
