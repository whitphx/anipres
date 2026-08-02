// Editor-facing helpers that survived the v1 model removal: track-id
// minting and group-leaf traversal. The v1 frame types and their
// serializers/getters lived here until the one-time v1 -> v2 batch
// migration ran (design doc r9).
import { uniqueId, type Editor, type TLShape } from "tldraw";
import { GroupShapeUtil } from "tldraw";

export function newTrackId(): string {
  // Use a timestamp to make the tracks sorted in the timeline.
  return `track-${Date.now()}-${uniqueId()}`;
}

export function getLeafShapes(
  editor: Editor,
  ancestorShape: TLShape,
): TLShape[] {
  if (ancestorShape.type !== GroupShapeUtil.type) {
    return [ancestorShape];
  }

  const childShapeIds = editor.getSortedChildIdsForParent(ancestorShape.id);
  const childShapes = childShapeIds
    .map((id) => editor.getShape(id))
    .filter((shape) => shape != null);
  return childShapes.flatMap((childShape) => getLeafShapes(editor, childShape));
}
