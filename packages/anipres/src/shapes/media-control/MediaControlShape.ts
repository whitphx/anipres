import type {
  Editor,
  RecordProps,
  TLBaseShape,
  TLShape,
  TLShapeId,
} from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../youtube-embed/YouTubeEmbedShape";
import { getMediaControlBindingTargetId } from "./MediaControlBinding";
import { parseFrameMeta } from "../../timeline-model/parse";
import {
  getDefaultAnchorCarrier,
  groupCarriersByVideoKey,
} from "../../media/video-anchor";

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
 * The `videoKey` a marker's event acts on, or null for an orphan.
 *
 * The key travels in the frame's action, which is why the binding is no
 * longer needed: with several carriers per video, a binding to one
 * keyframe would name a shape rather than the video. The binding is
 * still read as a fallback so a document that has not been normalized
 * yet — one opened straight from storage, before the mount pass runs —
 * still resolves its events.
 */
export function resolveMediaControlVideoKey(
  editor: Editor,
  markerShapeId: string,
): string | null {
  const marker = editor.getShape(markerShapeId as TLShapeId);
  if (marker?.type !== MediaControlShapeType) {
    return null;
  }
  const parsed = parseFrameMeta(marker.meta?.frame);
  if (
    parsed.kind === "v2" &&
    parsed.frame.action.type === "mediaControl" &&
    parsed.frame.action.videoKey != null
  ) {
    return parsed.frame.action.videoKey;
  }
  const targetId = getMediaControlBindingTargetId(editor, marker.id);
  const target = targetId != null ? editor.getShape(targetId) : null;
  return isYouTubeEmbedShape(target) ? getVideoKey(target) : null;
}

/**
 * A representative carrier of the video a marker controls — its default
 * anchor — or null when the video has no carrier left.
 */
export function resolveMediaControlTarget(
  editor: Editor,
  markerShapeId: string,
): TLShape | null {
  const videoKey = resolveMediaControlVideoKey(editor, markerShapeId);
  if (videoKey == null) {
    return null;
  }
  const carriers = groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
    videoKey,
  );
  return carriers != null ? getDefaultAnchorCarrier(carriers) : null;
}
