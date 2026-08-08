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

export type MediaControlShapeProps = Record<string, never>;

/**
 * An invisible record that carries one animation frame in its
 * `meta.frame` for a video it is bound to (see
 * {@link MediaControlBinding}), exactly like any other framed shape —
 * which is what lets media events reuse the whole timeline machinery
 * (steps, sub frames, drag & drop, reconciliation) without changing the
 * one-frame-per-shape data model. It is a shape only because shapes and
 * bindings are tldraw's extension points for synced records: it never
 * renders, exposes no hit area, and `getShapeVisibility` excludes it
 * from the canvas entirely. Its visual representation is the media-event
 * strip drawn by the YouTube embed shape's own component.
 */
export type MediaControlShape = TLBaseShape<
  typeof MediaControlShapeType,
  MediaControlShapeProps
>;

export const mediaControlShapeProps: RecordProps<MediaControlShape> = {};

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
