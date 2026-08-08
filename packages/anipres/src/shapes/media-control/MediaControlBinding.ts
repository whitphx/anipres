import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export type MediaControlBindingProps = Record<string, never>;

/**
 * The one canonical record of "this marker belongs to that video":
 * `fromId` is the marker, `toId` is the video. Modeled as a tldraw
 * binding — not `parentId` — because arbitrary shapes are not containers
 * in tldraw: the editor re-parents children of a non-container shape to
 * the page on the next interaction, silently severing the link. A
 * binding survives that, and the BindingUtil gives the relationship its
 * lifecycle behavior (markers are deleted with their video) in one
 * place. tldraw also remaps bindings on copy/paste/duplicate when both
 * ends are included.
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

/** Binds a marker to a video. */
export function bindMediaControlMarker(
  editor: Editor,
  markerShapeId: TLShapeId,
  videoShapeId: TLShapeId,
): void {
  editor.createBinding<MediaControlBinding>({
    type: MediaControlBindingType,
    fromId: markerShapeId,
    toId: videoShapeId,
    props: {},
  });
}

/**
 * Binds `newMarkerShapeId` to the same video as `sourceMarkerShapeId`.
 * For code paths that clone a marker via `createShape` (e.g. the
 * group-clone path): a raw shape copy carries the frame meta but not the
 * binding, which lives in a separate record.
 */
export function copyMediaControlBinding(
  editor: Editor,
  sourceMarkerShapeId: TLShapeId,
  newMarkerShapeId: TLShapeId,
): void {
  const targetId = getMediaControlBindingTargetId(editor, sourceMarkerShapeId);
  if (targetId == null) {
    return;
  }
  bindMediaControlMarker(editor, newMarkerShapeId, targetId);
}
