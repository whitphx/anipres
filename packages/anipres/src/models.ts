import { GroupShapeUtil, uniqueId, type Editor, type TLShape } from "tldraw";

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
