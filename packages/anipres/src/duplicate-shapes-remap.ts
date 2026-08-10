// Relationship-preserving remap for `editor.duplicateShapes` — the path
// tldraw's Duplicate action (Cmd/Ctrl+D, context menu) actually takes. It
// creates copies via `createShapes` directly, bypassing
// `putContentOntoCurrentPage`, so without this wrapper every copied cue
// would be freshened shape-at-a-time by the beforeCreate safety net:
// copies of a simultaneous step would land on N separate steps and copied
// track sequences would lose their shared track.
//
// Mechanism: while the wrapped call runs, the beforeCreate safety net
// hands every created v2-framed copy to `capture()` (leaving its meta
// untouched); afterwards the complete set goes through the same
// order-independent `remapContentFrames` transform the paste path uses,
// with `operation: "duplicate"` and the PRE-call document state, all in
// one transaction with the creation itself.

import { uniqueId, type Editor, type TLShape, type TLShapeId } from "tldraw";
import type { VecLike } from "tldraw";
import { expandShapeIdsWithMediaControlMarkers } from "./shapes/media-control/expand-with-markers";
import { remapDuplicatedVideoKeys } from "./media/remap-video-keys";
import {
  frameToMetaJson,
  parseFrameMeta,
  remapContentFrames,
  type TimelineDoc,
} from "./timeline-model";

/**
 * Applies collision-run step-key rewrites by STORED stepId: the write
 * reaches every cue sharing the step identity — including split members
 * displayed under synthetic recovery steps, which a walk over the derived
 * doc's batches would miss (fabricating a step-key-divergence).
 */
export function applyStoredStepKeyUpdates(
  editor: Editor,
  updates: readonly { stepId: string; key: string }[],
): void {
  if (updates.length === 0) return;
  for (const shape of editor.getCurrentPageShapes()) {
    const parsed = parseFrameMeta(shape.meta?.frame);
    if (parsed.kind !== "v2") continue;
    const frame = parsed.frame;
    if (frame.type !== "cue") continue;
    const update = updates.find((u) => u.stepId === frame.stepId);
    if (update == null || frame.stepOrderKey === update.key) continue;
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        ...shape.meta,
        frame: frameToMetaJson({ ...frame, stepOrderKey: update.key }),
      },
    });
  }
}

export interface DuplicateShapesRemap {
  /** Wraps `editor.duplicateShapes`. Call once on mount. */
  install(): void;
  /**
   * beforeCreate hook: while a wrapped duplicateShapes call is running,
   * records the created copy (the caller must then leave its meta
   * untouched — the wrapper rewrites the complete set afterwards).
   * Returns false outside a wrapped call.
   */
  capture(shapeId: TLShapeId): boolean;
}

export function createDuplicateShapesRemap(
  editor: Editor,
  getTimelineDoc: () => TimelineDoc,
): DuplicateShapesRemap {
  let capturing: TLShapeId[] | null = null;

  const capture = (shapeId: TLShapeId): boolean => {
    if (capturing == null) {
      return false;
    }
    capturing.push(shapeId);
    return true;
  };

  const install = () => {
    const editorWithDup = editor as Editor & {
      duplicateShapes?: (
        shapes: TLShapeId[] | TLShape[],
        offset?: VecLike,
      ) => Editor;
    };
    if (typeof editorWithDup.duplicateShapes !== "function") {
      console.warn(
        "anipres: editor.duplicateShapes is missing or has an unexpected signature. " +
          "Duplicated animation frames will be freshened per-shape without relationship preservation.",
      );
      return;
    }
    const original = editorWithDup.duplicateShapes.bind(editor);
    editorWithDup.duplicateShapes = (shapes, offset) => {
      if (capturing != null) {
        // Re-entrant call: the outer wrapper captures and remaps.
        return original(shapes, offset);
      }
      // PRE-call state: the copies must collide against the originals and
      // be placed relative to the pre-duplication timeline, exactly like
      // the paste path.
      const existingFrameIds = new Set<string>();
      const existingStepIds = new Set<string>();
      const existingTrackIds = new Set<string>();
      for (const shape of editor.getCurrentPageShapes()) {
        const parsed = parseFrameMeta(shape.meta?.frame);
        if (parsed.kind !== "v2" && parsed.kind !== "v1") continue;
        existingFrameIds.add(parsed.frame.id);
        if (parsed.frame.type === "cue") {
          existingTrackIds.add(parsed.frame.trackId);
          if (parsed.kind === "v2") {
            existingStepIds.add(parsed.frame.stepId);
          }
        }
      }
      const currentDoc = getTimelineDoc();
      const created: TLShapeId[] = [];
      let result: Editor = editor;
      editor.run(() => {
        capturing = created;
        try {
          // Duplicating a video must carry its media events, same as
          // copy; see expandShapeIdsWithMediaControlMarkers.
          result = original(
            expandShapeIdsWithMediaControlMarkers(editor, shapes),
            offset,
          );
        } finally {
          capturing = null;
        }
        // A duplicate is an independent video, not another carrier of
        // the source: mint its own key so the copied events retarget
        // with the rest of the operation. Derived from the resulting
        // selection rather than from `created`, because that capture is
        // fed by the caller's beforeCreate safety net — video identity
        // must not depend on whether one is installed.
        remapDuplicatedVideoKeys(editor, [
          ...editor.getShapeAndDescendantIds(editor.getSelectedShapeIds()),
        ]);
        if (created.length === 0) {
          return;
        }
        const remap = remapContentFrames({
          shapes: created.map((shapeId) => ({
            shapeId: shapeId as string,
            frameMeta: editor.getShape(shapeId)?.meta?.frame,
          })),
          existing: {
            frameIds: existingFrameIds,
            stepIds: existingStepIds,
            trackIds: existingTrackIds,
          },
          currentDoc,
          operation: "duplicate",
          mintId: uniqueId,
        });
        applyStoredStepKeyUpdates(editor, remap.existingStepKeyUpdates);
        for (const [shapeId, frame] of remap.updatedFrames) {
          const shape = editor.getShape(shapeId as TLShapeId);
          if (shape == null) continue;
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            meta: { ...shape.meta, frame: frameToMetaJson(frame) },
          });
        }
      });
      return result;
    };
  };

  return { install, capture };
}
