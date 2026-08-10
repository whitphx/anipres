import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "./MediaControlShape";

/**
 * Expands a shape set with the media-control markers belonging to any
 * included video. Markers are invisible and unselectable, so no
 * selection-based operation (copy, duplicate) can include them by
 * itself; wrappers around those operations call this first, and the
 * copies then carry the video's `videoKey` in their own frames — which
 * the remap rewrites to the copy's fresh key.
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
  const includedVideoKeys = new Set<string>();
  for (const id of descendants) {
    const shape = editor.getShape(id);
    if (isYouTubeEmbedShape(shape)) {
      includedVideoKeys.add(getVideoKey(shape));
    }
  }
  const expanded = new Set(ids);
  if (includedVideoKeys.size === 0) {
    return [...expanded];
  }
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    // A marker swept into an included group (select-all can do that)
    // is already carried as a descendant.
    if (descendants.has(shape.id)) {
      continue;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    if (videoKey != null && includedVideoKeys.has(videoKey)) {
      expanded.add(shape.id);
    }
  }
  return [...expanded];
}
