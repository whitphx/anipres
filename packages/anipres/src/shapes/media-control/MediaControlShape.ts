import type {
  Editor,
  RecordProps,
  TLBaseShape,
  TLShape,
  TLShapeId,
} from "tldraw";
import { YouTubeEmbedShapeType } from "../youtube-embed/YouTubeEmbedShape";

export const MediaControlShapeType = "media-control" as const;

/**
 * A marker that carries one mediaControl animation frame in its
 * `meta.frame`, exactly like any other framed shape — which is what lets
 * media events reuse the whole timeline machinery (steps, sub frames,
 * drag & drop, reconciliation) without changing the one-frame-per-shape
 * data model. The marker's target is its PARENT shape: parenting makes
 * tldraw cascade deletion, move the marker with the video, and remap the
 * relationship on copy/paste.
 */
export type MediaControlShape = TLBaseShape<
  typeof MediaControlShapeType,
  Record<string, never>
>;

export const mediaControlShapeProps: RecordProps<MediaControlShape> = {};

/** Rendered size of the marker badge (the shape has no w/h props). */
export const MEDIA_CONTROL_SHAPE_SIZE = 28;

/**
 * Resolves the media shape a marker controls, or null for an orphaned
 * marker (e.g. pasted without its video: tldraw reparents it to the
 * page).
 */
export function resolveMediaControlTarget(
  editor: Editor,
  markerShapeId: string,
): TLShape | null {
  const marker = editor.getShape(markerShapeId as TLShapeId);
  if (marker?.type !== MediaControlShapeType) {
    return null;
  }
  const parent = editor.getShape(marker.parentId as TLShapeId);
  return parent?.type === YouTubeEmbedShapeType ? parent : null;
}
