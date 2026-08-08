import type { MediaControlCommand, TimelineDoc } from "../../timeline-model";

export interface MediaEventStripItem {
  markerShapeId: string;
  command: MediaControlCommand;
  /** 0-based presentation step the event fires on. */
  stepIndex: number;
}

export const MEDIA_COMMAND_ICONS: Record<MediaControlCommand, string> = {
  play: "▶",
  pause: "⏸",
  stop: "⏹",
  mute: "🔇",
  unmute: "🔊",
  setVolume: "🎚",
};

/**
 * The media events carried by the given marker shapes, in presentation
 * order. Detached frames are excluded: they never play, and the
 * timeline surfaces them as diagnostics.
 */
export function listMediaEvents(
  doc: TimelineDoc,
  markerShapeIds: ReadonlySet<string>,
): MediaEventStripItem[] {
  const items: MediaEventStripItem[] = [];
  doc.steps.forEach((step, stepIndex) => {
    for (const batch of step.batches) {
      for (const frame of batch.frames) {
        if (
          frame.action.type === "mediaControl" &&
          markerShapeIds.has(frame.shapeId)
        ) {
          items.push({
            markerShapeId: frame.shapeId,
            command: frame.action.command,
            stepIndex,
          });
        }
      }
    }
  });
  return items;
}
