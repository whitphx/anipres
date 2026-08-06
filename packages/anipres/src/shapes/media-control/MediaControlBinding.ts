import { T } from "tldraw";
import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export interface MediaControlBindingProps {
  /**
   * The marker's page-space offset from the video's page-bounds
   * top-left. The BindingUtil repositions the marker to this anchor
   * whenever the video changes — absolute repositioning rather than
   * delta translation, so dragging the video and its markers together
   * cannot apply the move twice (the pattern of tldraw's sticker
   * bindings example).
   */
  anchorX: number;
  anchorY: number;
}

/**
 * The one canonical record of "this marker belongs to that video":
 * `fromId` is the marker, `toId` is the video. Modeled as a tldraw
 * binding — not `parentId` — because arbitrary shapes are not containers
 * in tldraw: the editor re-parents children of a non-container shape to
 * the page on the next interaction, silently severing the link. A
 * binding survives that, and the BindingUtil gives the relationship its
 * behavior (markers follow the video, are deleted with it) in one place.
 * tldraw also remaps bindings on copy/paste/duplicate when both ends are
 * included, and drops them when only one is — the orphan-marker case the
 * badge already renders as a warning.
 */
export type MediaControlBinding = TLBaseBinding<
  typeof MediaControlBindingType,
  MediaControlBindingProps
>;

export const mediaControlBindingProps: RecordProps<MediaControlBinding> = {
  anchorX: T.number,
  anchorY: T.number,
};

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

/**
 * Binds a marker to a video, anchored at the marker's current position
 * relative to the video.
 */
export function bindMediaControlMarker(
  editor: Editor,
  markerShapeId: TLShapeId,
  videoShapeId: TLShapeId,
): void {
  const marker = editor.getShape(markerShapeId);
  const videoBounds = editor.getShapePageBounds(videoShapeId);
  editor.createBinding<MediaControlBinding>({
    type: MediaControlBindingType,
    fromId: markerShapeId,
    toId: videoShapeId,
    props: {
      anchorX: (marker?.x ?? 0) - (videoBounds?.x ?? 0),
      anchorY: (marker?.y ?? 0) - (videoBounds?.y ?? 0),
    },
  });
}

/**
 * Binds `newMarkerShapeId` to the same video as `sourceMarkerShapeId`.
 * For code paths that clone a marker via `createShape` (the timeline's
 * follow-up-event buttons): a raw shape copy carries the frame meta but
 * not the binding, which lives in a separate record.
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

/**
 * Re-anchors a marker's binding at the marker's current position — the
 * counterpart of the BindingUtil's absolute repositioning, called when
 * the marker alone has been moved.
 */
export function updateMediaControlBindingAnchor(
  editor: Editor,
  markerShapeId: TLShapeId,
): void {
  const [binding] = editor.getBindingsFromShape<MediaControlBinding>(
    markerShapeId,
    MediaControlBindingType,
  );
  if (binding == null) {
    return;
  }
  const marker = editor.getShape(markerShapeId);
  const videoBounds = editor.getShapePageBounds(binding.toId);
  if (marker == null || videoBounds == null) {
    return;
  }
  editor.updateBinding<MediaControlBinding>({
    ...binding,
    props: {
      anchorX: marker.x - videoBounds.x,
      anchorY: marker.y - videoBounds.y,
    },
  });
}
