import { T } from "tldraw";
import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export interface MediaControlBindingProps {
  /**
   * The marker's page-space offset from the video's page-bounds
   * top-left. The BindingUtil repositions the marker to this anchor
   * whenever the video changes — absolute repositioning rather than
   * delta translation, so dragging the video and its markers together
   * cannot apply the move twice. The anchored-repositioning approach is
   * adapted from tldraw's sticker-bindings example
   * (https://tldraw.dev/examples/sticker-bindings; part of the tldraw
   * SDK this project is built on and licensed under).
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
 * The marker's current page-space offset from the video, or null when
 * either shape is gone. Page bounds on both sides — the marker's own
 * x/y are parent-space and the marker is not guaranteed to stay a page
 * child (the user can group it).
 */
export function getMediaControlMarkerAnchor(
  editor: Editor,
  markerShapeId: TLShapeId,
  videoShapeId: TLShapeId,
): MediaControlBindingProps | null {
  const markerBounds = editor.getShapePageBounds(markerShapeId);
  const videoBounds = editor.getShapePageBounds(videoShapeId);
  if (markerBounds == null || videoBounds == null) {
    return null;
  }
  return {
    anchorX: markerBounds.x - videoBounds.x,
    anchorY: markerBounds.y - videoBounds.y,
  };
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
  const props = getMediaControlMarkerAnchor(
    editor,
    markerShapeId,
    videoShapeId,
  );
  if (props == null) {
    return;
  }
  editor.createBinding<MediaControlBinding>({
    type: MediaControlBindingType,
    fromId: markerShapeId,
    toId: videoShapeId,
    props,
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
