// Declarative playback state for media shapes, derived by folding
// mediaControl frames over the runtime steps. Playback commands are
// events, but navigation must be deterministic under arbitrary jumps
// (clicking a step, moving backward): the fold turns the event history
// up to a step into the state the players should be in, so the manager
// can reconcile toward it instead of replaying events.

import type { MediaControlFrameAction } from "../timeline-model";
import type { RuntimeStep } from "../timeline-model/runtime-steps";

export interface MediaPlaybackState {
  status: "unstarted" | "playing" | "paused";
  /** null = untouched by any event; reconciliation applies the player's baseline. */
  muted: boolean | null;
  /** null = untouched by any event; reconciliation applies the player's baseline. */
  volume: number | null;
}

export const INITIAL_MEDIA_PLAYBACK_STATE: MediaPlaybackState = {
  status: "unstarted",
  muted: null,
  volume: null,
};

export const DEFAULT_MEDIA_VOLUME = 100;

export function applyMediaCommand(
  state: MediaPlaybackState,
  action: MediaControlFrameAction,
): MediaPlaybackState {
  switch (action.command) {
    case "play":
      return { ...state, status: "playing" };
    case "pause":
      return { ...state, status: "paused" };
    case "stop":
      return { ...state, status: "unstarted" };
    case "mute":
      return { ...state, muted: true };
    case "unmute":
      return { ...state, muted: false };
    case "setVolume":
      return { ...state, volume: action.volume ?? DEFAULT_MEDIA_VOLUME };
  }
}

/**
 * Folds every mediaControl frame in steps [0, uptoStepIndex] into the
 * per-target playback state. Targets are resolved through the injected
 * callback (the marker's bound video in the live editor); frames whose
 * target cannot be resolved are skipped.
 */
export function foldMediaPlaybackStates(
  steps: RuntimeStep[],
  uptoStepIndex: number,
  resolveTargetId: (markerShapeId: string) => string | null,
): Map<string, MediaPlaybackState> {
  const states = new Map<string, MediaPlaybackState>();
  for (const step of steps.slice(0, uptoStepIndex + 1)) {
    for (const batch of step) {
      for (const frame of batch.data) {
        if (frame.action.type !== "mediaControl") {
          continue;
        }
        const targetId = resolveTargetId(frame.shapeId);
        if (targetId == null) {
          continue;
        }
        states.set(
          targetId,
          applyMediaCommand(
            states.get(targetId) ?? INITIAL_MEDIA_PLAYBACK_STATE,
            frame.action,
          ),
        );
      }
    }
  }
  return states;
}
