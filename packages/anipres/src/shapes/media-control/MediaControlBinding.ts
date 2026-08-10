import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export type MediaControlBindingProps = Record<string, never>;

/**
 * How a document written before videos carried their own identity
 * recorded which video an event controls, `fromId` being the marker and
 * `toId` the video.
 *
 * A legacy input format, and nothing else. Nothing writes one, and
 * nothing resolves an event through one: an event names its video by
 * `videoKey` in its own frame, which a video that is several carriers
 * needs, since a binding to one keyframe would tie the whole video's
 * events to that keyframe's fate. Two records of the same fact is what
 * this design is rid of — every path that created, copied, moved or
 * deleted a carrier had to keep them in step.
 *
 * `convertLegacyVideoIdentity` reads it once, off-line, to recover the
 * key, then deletes it. The type stays registered so an unconverted
 * document loads far enough to be converted; see
 * `MediaControlBindingUtil`.
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
