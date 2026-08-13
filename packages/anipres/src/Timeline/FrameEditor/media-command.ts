import {
  type MediaControlCommand,
  type MediaControlFrameAction,
} from "../../timeline-model";
import { DEFAULT_MEDIA_VOLUME } from "../../media/media-state";

/**
 * Rebuilds a valid mediaControl action for a new command: `volume` is
 * only allowed alongside setVolume, so it must be added/stripped rather
 * than spread through.
 */
export function withCommand(
  action: MediaControlFrameAction,
  command: MediaControlCommand,
): MediaControlFrameAction {
  return {
    type: "mediaControl",
    command,
    // Which video the event controls is not the command's to change:
    // an event that lost its key names nothing, and the timeline drops
    // a marker naming no video, taking the event with it.
    ...(action.videoKey !== undefined ? { videoKey: action.videoKey } : {}),
    ...(action.duration !== undefined ? { duration: action.duration } : {}),
    ...(command === "setVolume"
      ? { volume: action.volume ?? DEFAULT_MEDIA_VOLUME }
      : {}),
  };
}
