import type { Editor, TLShape, TLShapeId } from "tldraw";
import { YouTubeEmbedShapeType } from "../youtube-embed/YouTubeEmbedShape";
import { MediaControlBindingType } from "./MediaControlBinding";

/**
 * Expands a shape set with the media-control markers bound to any
 * included video. Markers are invisible and unselectable, so no
 * selection-based operation (copy, duplicate) can include them by
 * itself; wrappers around those operations call this first, and tldraw
 * then carries each marker↔video binding along because both of its
 * ends are included. Descendants are walked so videos nested in
 * included groups are covered.
 */
export function expandShapeIdsWithMediaControlMarkers(
  editor: Editor,
  shapes: TLShapeId[] | TLShape[],
): TLShapeId[] {
  const ids = shapes.map((shape) =>
    typeof shape === "string" ? shape : shape.id,
  );
  const expanded = new Set(editor.getShapeAndDescendantIds(ids));
  for (const id of [...expanded]) {
    if (editor.getShape(id)?.type !== YouTubeEmbedShapeType) {
      continue;
    }
    for (const binding of editor.getBindingsToShape(
      id,
      MediaControlBindingType,
    )) {
      expanded.add(binding.fromId);
    }
  }
  return [...expanded];
}
