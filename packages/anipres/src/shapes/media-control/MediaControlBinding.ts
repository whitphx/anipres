import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export type MediaControlBindingProps = Record<string, never>;

/**
 * Legacy: how a marker used to record which video its event controls,
 * `fromId` being the marker and `toId` the video. Nothing writes one any
 * more — an event names its video by `videoKey` in its own frame, which
 * a video that is several carriers needs, since a binding to one
 * keyframe would tie the whole video's events to that keyframe's fate.
 *
 * The type stays registered so a document written before the change
 * still validates, and `normalizeVideoIdentity` reads it once on load to
 * recover the target key. See `MediaControlBindingUtil`.
 */
export type MediaControlBinding = TLBaseBinding<
  typeof MediaControlBindingType,
  MediaControlBindingProps
>;

export const mediaControlBindingProps: RecordProps<MediaControlBinding> = {};

/** The video a marker is bound to, or null for an orphaned marker. */
export function getMediaControlBindingTargetId(
  editor: Editor,
  markerShapeId: TLShapeId,
): TLShapeId | null {
  const [binding] = editor.getBindingsFromShape<MediaControlBinding>(
    markerShapeId,
    MediaControlBindingType,
  );
  return binding?.toId ?? null;
}
