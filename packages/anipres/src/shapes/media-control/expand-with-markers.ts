import type { Editor, TLShape, TLShapeId } from "tldraw";
import { YouTubeEmbedShapeType } from "../youtube-embed/YouTubeEmbedShape";
import { MediaControlBindingType } from "./MediaControlBinding";

/**
 * Expands a shape set with the media-control markers bound to any
 * included video. Markers are invisible and unselectable, so no
 * selection-based operation (copy, duplicate) can include them by
 * itself; wrappers around those operations call this first, and tldraw
 * then carries each marker↔video binding along because both of its
 * ends are included.
 *
 * Only marker ids not already covered by the set are ADDED —
 * descendants are walked purely to discover videos nested in included
 * groups. Both tldraw operations expand descendants themselves, and
 * `duplicateShapes` applies its offset to every explicitly supplied id,
 * so passing a shape that is also a descendant of another included
 * shape would displace it twice. The markers that are added sit outside
 * every included subtree (typically as page children parked at their
 * video's origin), so the offset lands their copies exactly at the
 * duplicated video's origin.
 */
export function expandShapeIdsWithMediaControlMarkers(
  editor: Editor,
  shapes: TLShapeId[] | TLShape[],
): TLShapeId[] {
  const ids = shapes.map((shape) =>
    typeof shape === "string" ? shape : shape.id,
  );
  const descendants = editor.getShapeAndDescendantIds(ids);
  const expanded = new Set(ids);
  for (const id of descendants) {
    if (editor.getShape(id)?.type !== YouTubeEmbedShapeType) {
      continue;
    }
    for (const binding of editor.getBindingsToShape(
      id,
      MediaControlBindingType,
    )) {
      // A marker swept into an included group (select-all can do that)
      // is already carried as a descendant.
      if (descendants.has(binding.fromId)) {
        continue;
      }
      expanded.add(binding.fromId);
    }
  }
  return [...expanded];
}
