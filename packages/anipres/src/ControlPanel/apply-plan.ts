import type { Editor, TLShapeId } from "tldraw";
import { frameToMetaJson, parseFrameMeta, type Frame } from "../timeline-model";
import type { SubFrameAddAfterPlan } from "./operations";

/** Stores a frame on its carrying shape, leaving the rest of the meta alone. */
export function writeFrame(
  editor: Editor,
  shapeId: TLShapeId,
  frame: Frame,
): void {
  const shape = editor.getShape(shapeId);
  if (shape == null) {
    return;
  }
  editor.updateShape({
    id: shape.id,
    type: shape.type,
    meta: { ...shape.meta, frame: frameToMetaJson(frame) },
  });
}

/**
 * Applies the rewrites a sub-frame insertion asks for: cue-id freshening
 * (duplicate-id disambiguation) and the order keys existing sub frames
 * move to. Both share the transaction with the new sub frame's creation,
 * so callers run this inside the same `editor.run` that creates it.
 */
export function applySubFrameAddAfterPlan(
  editor: Editor,
  plan: SubFrameAddAfterPlan,
): void {
  if (plan.cueFrameUpdate != null) {
    writeFrame(
      editor,
      plan.cueFrameUpdate.shapeId as TLShapeId,
      plan.cueFrameUpdate.frame,
    );
  }
  for (const { shapeId, key } of plan.keyUpdates) {
    const parsed = parseFrameMeta(
      editor.getShape(shapeId as TLShapeId)?.meta?.frame,
    );
    if (parsed.kind === "v2" && parsed.frame.type === "sub") {
      writeFrame(editor, shapeId as TLShapeId, {
        ...parsed.frame,
        orderKey: key,
      });
    }
  }
}
