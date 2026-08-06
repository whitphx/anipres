import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  T,
} from "tldraw";
import type {
  Editor,
  RecordProps,
  TLBaseShape,
  TLShape,
  TLShapeId,
} from "tldraw";
import { YouTubeEmbedShapeType } from "../youtube-embed/YouTubeEmbedShape";
import { getMediaControlBindingTargetId } from "./MediaControlBinding";

export const MediaControlShapeType = "media-control" as const;

export interface MediaControlShapeProps {
  /**
   * Target size for a marker that carries a `shapeAnimation` frame on
   * its video's track — the designed representation of "move/resize the
   * video during the presentation", where the marker's own transform is
   * the keyframe target (the video shape itself cannot be copied per
   * keyframe: a copy would mount a second live player). Playback of such
   * frames is not implemented yet; the props are part of the persisted
   * schema from the start because adding them later costs a shape-schema
   * migration. Null on ordinary media-event markers.
   */
  w: number | null;
  h: number | null;
}

/**
 * A marker that carries one animation frame in its `meta.frame` for a
 * video it is bound to (see {@link MediaControlBinding}), exactly like
 * any other framed shape — which is what lets media events reuse the
 * whole timeline machinery (steps, sub frames, drag & drop,
 * reconciliation) without changing the one-frame-per-shape data model.
 * Markers are editing chrome: hidden in presentation mode (like slide
 * shapes), while their frames still drive playback. An unbound marker
 * (e.g. pasted without its video) renders as a warning badge and its
 * events no-op.
 */
export type MediaControlShape = TLBaseShape<
  typeof MediaControlShapeType,
  MediaControlShapeProps
>;

export const mediaControlShapeProps: RecordProps<MediaControlShape> = {
  w: T.nonZeroNumber.nullable(),
  h: T.nonZeroNumber.nullable(),
};

const mediaControlShapeVersions = createShapePropsMigrationIds(
  MediaControlShapeType,
  {
    AddTargetSize: 1,
  },
);

export const mediaControlShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: mediaControlShapeVersions.AddTargetSize,
      up: (props) => {
        props.w ??= null;
        props.h ??= null;
      },
      down: (props) => {
        delete props.w;
        delete props.h;
      },
    },
  ],
});

/** Rendered size of the marker badge. */
export const MEDIA_CONTROL_SHAPE_SIZE = 28;

/**
 * Resolves the media shape a marker controls, or null for an orphaned
 * marker.
 */
export function resolveMediaControlTarget(
  editor: Editor,
  markerShapeId: string,
): TLShape | null {
  const marker = editor.getShape(markerShapeId as TLShapeId);
  if (marker?.type !== MediaControlShapeType) {
    return null;
  }
  const targetId = getMediaControlBindingTargetId(editor, marker.id);
  const target = targetId != null ? editor.getShape(targetId) : null;
  return target?.type === YouTubeEmbedShapeType ? target : null;
}
