import {
  track,
  stopEventPropagation,
  createShapeId,
  uniqueId,
  type Editor,
  GroupShapeUtil,
  TLShapeId,
  TLShape,
} from "tldraw";
import {
  frameToMetaJson,
  interactiveKeyAbove,
  makeInsertionSpace,
  parseFrameMeta,
  planDuplicateFrameIdRepair,
  reconcileEditedSteps,
  type CueFrame,
  type EditedStep,
  type Frame,
  type SubFrame,
  type TimelineDiagnostic,
  type TimelineDoc,
} from "../timeline-model";
import { getLeafShapes } from "../models";
import type { FrameUIData } from "../Timeline/frame-ui-data";
import { Timeline, type ShapeSelection } from "../Timeline";
import styles from "./ControlPanel.module.scss";
import { SlideShapeType } from "../shapes/slide/SlideShape";
import type { PresentationManager } from "../presentation-manager";

const COPIED_SHAPE_POSITION_OFFSET = { x: 100, y: 100 };

/** Finds the doc position (step index, batch) of a frame id. */
function findFramePosition(doc: TimelineDoc, frameId: string) {
  for (let stepIndex = 0; stepIndex < doc.steps.length; stepIndex++) {
    for (const batch of doc.steps[stepIndex].batches) {
      const frameIndex = batch.frames.findIndex((f) => f.frameId === frameId);
      if (frameIndex >= 0) {
        return { stepIndex, batch, frameIndex };
      }
    }
  }
  return null;
}

export interface ControlPanelProps {
  editor: Editor;
  presentationManager: PresentationManager;
  currentStepIndex: number;
  onCurrentStepIndexChange: (newIndex: number) => void;
  onPresentationModeEnter: () => void;
}
export const ControlPanel = track((props: ControlPanelProps) => {
  const {
    editor,
    presentationManager,
    currentStepIndex,
    onCurrentStepIndexChange,
    onPresentationModeEnter,
  } = props;

  const doc = presentationManager.$getTimelineDoc();

  const selectedShapes = editor.getSelectedShapes();

  const getStoredFrame = (shape: TLShape): Frame | null => {
    const parsed = parseFrameMeta(shape.meta?.frame);
    return parsed.kind === "v2" ? parsed.frame : null;
  };

  const collectStoredFrames = () => {
    return presentationManager
      .$getCurrentPageDescendantShapes()
      .flatMap((shape) => {
        const frame = getStoredFrame(shape);
        return frame != null ? [{ shapeId: shape.id as string, frame }] : [];
      });
  };

  const shapeSelections: ShapeSelection[] = selectedShapes.map((shape) => {
    const leafShapes = getLeafShapes(editor, shape);
    const leafFrameShapeIds = leafShapes
      .filter((leafShape) => getStoredFrame(leafShape) != null)
      .map((leafShape) => leafShape.id as string);
    return {
      shapeId: shape.id,
      frameShapeIds: leafFrameShapeIds,
    };
  });

  const selectedAnimeFrameAttachableShapes = selectedShapes
    .map((shape) => {
      if (shape.type === SlideShapeType) {
        return null;
      }

      if (shape.type === GroupShapeUtil.type) {
        const leafShapes = getLeafShapes(editor, shape);
        const everyLeafShapeHasNoFrame = leafShapes.every(
          (leafShape) => parseFrameMeta(leafShape.meta?.frame).kind === "none",
        );
        return everyLeafShapeHasNoFrame ? shape : null;
      }

      return parseFrameMeta(shape.meta?.frame).kind === "none" ? shape : null;
    })
    .filter((shape) => shape != null);

  const writeFrame = (shapeId: TLShapeId, frame: Frame) => {
    const shape = editor.getShape(shapeId);
    if (shape == null) {
      return;
    }
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        ...shape.meta,
        frame: frameToMetaJson(frame),
      },
    });
  };

  /**
   * Applies step-key rewrites produced by collision-run normalization —
   * bounded to the run, executed inline in the mutating transaction.
   */
  const applyStepKeyUpdates = (updates: { id: string; key: string }[]) => {
    for (const { id: stepId, key } of updates) {
      const step = doc.steps.find((s) => s.id === stepId);
      if (step == null) continue;
      for (const batch of step.batches) {
        const cueShape = editor.getShape(batch.frames[0].shapeId as TLShapeId);
        if (cueShape == null) continue;
        const frame = getStoredFrame(cueShape);
        if (frame?.type !== "cue") continue;
        writeFrame(cueShape.id, { ...frame, stepOrderKey: key });
      }
    }
  };

  const handleFrameChange = (newFrame: FrameUIData) => {
    // Only the action is editable through the frame editor UI.
    const shape = editor.getShape(newFrame.shapeId as TLShapeId);
    if (shape == null) {
      return;
    }
    const frame = getStoredFrame(shape);
    if (frame == null) {
      return;
    }
    writeFrame(shape.id, { ...frame, action: newFrame.action });
  };

  const handleEditedStepsChange = (editedSteps: EditedStep[]) => {
    const result = reconcileEditedSteps({
      currentFrames: collectStoredFrames(),
      editedSteps,
      mintId: uniqueId,
    });
    editor.run(() => {
      for (const { shapeId, frame } of result.updates) {
        writeFrame(shapeId as TLShapeId, frame);
      }
      for (const shapeId of result.removedShapeIds) {
        const shape = editor.getShape(shapeId as TLShapeId);
        if (shape == null) continue;
        const metaCopy = { ...shape.meta };
        delete metaCopy.frame;
        editor.updateShape({ id: shape.id, type: shape.type, meta: metaCopy });
      }
    });
  };

  const handleFrameSelect = (frameShapeId: string) => {
    const targetShape = editor.getShape(frameShapeId as TLShapeId);
    if (targetShape) {
      editor.select(targetShape);
    }
  };

  // --- Diagnostic resolution (design Risk 7). All repairs are
  // --- user-triggered semantic repairs — never auto-persisted.

  const clearFrame = (shapeId: TLShapeId) => {
    const shape = editor.getShape(shapeId);
    if (shape == null) {
      return;
    }
    const metaCopy = { ...shape.meta };
    delete metaCopy.frame;
    editor.updateShape({ id: shape.id, type: shape.type, meta: metaCopy });
  };

  const compareByFrameIdThenShapeId = (
    a: { shapeId: string; frame: Frame },
    b: { shapeId: string; frame: Frame },
  ) =>
    a.frame.id !== b.frame.id
      ? a.frame.id < b.frame.id
        ? -1
        : 1
      : a.shapeId < b.shapeId
        ? -1
        : a.shapeId > b.shapeId
          ? 1
          : 0;

  const selectedCue = (() => {
    const shape = editor.getOnlySelectedShape();
    if (shape == null) {
      return null;
    }
    const frame = getStoredFrame(shape);
    return frame?.type === "cue" ? { shapeId: shape.id, frame } : null;
  })();

  const handleDiagnosticSelect = (diagnostic: TimelineDiagnostic) => {
    const shapeIds =
      "shapeIds" in diagnostic ? diagnostic.shapeIds : [diagnostic.shapeId];
    const existing = shapeIds.filter(
      (id) => editor.getShape(id as TLShapeId) != null,
    ) as TLShapeId[];
    if (existing.length > 0) {
      editor.select(...existing);
    }
  };

  const handleResolveDiagnostic = (diagnostic: TimelineDiagnostic) => {
    switch (diagnostic.type) {
      case "invalid-frame":
      case "detached-sub-frame":
        clearFrame(diagnostic.shapeId as TLShapeId);
        return;
      case "step-key-divergence": {
        // Converge divergent keys to the canonical one — the
        // representative's (smallest frame.id), the same rule the
        // derivation canonicalizes with in memory.
        const members = collectStoredFrames()
          .filter(
            (entry): entry is { shapeId: string; frame: CueFrame } =>
              entry.frame.type === "cue" &&
              entry.frame.stepId === diagnostic.stepId,
          )
          .sort(compareByFrameIdThenShapeId);
        const canonicalKey = members[0]?.frame.stepOrderKey;
        if (canonicalKey == null) {
          return;
        }
        editor.run(() => {
          for (const member of members) {
            if (member.frame.stepOrderKey !== canonicalKey) {
              writeFrame(member.shapeId as TLShapeId, {
                ...member.frame,
                stepOrderKey: canonicalKey,
              });
            }
          }
        });
        return;
      }
      case "duplicate-frame-id": {
        // Keeper rule shared with the derivation's representative (cue
        // preferred), so the repair never detaches an attached sub frame.
        const plan = planDuplicateFrameIdRepair(
          collectStoredFrames(),
          diagnostic.frameId,
          uniqueId,
        );
        editor.run(() => {
          for (const update of plan.updates) {
            writeFrame(update.shapeId as TLShapeId, update.frame);
          }
        });
        return;
      }
      case "same-track-split": {
        // Materialize the derived split: the split-off cue gets its own
        // stored step directly after the source step.
        const members = collectStoredFrames()
          .filter(
            (entry): entry is { shapeId: string; frame: CueFrame } =>
              entry.frame.type === "cue" &&
              entry.frame.stepId === diagnostic.stepId &&
              entry.frame.trackId === diagnostic.trackId,
          )
          .sort(compareByFrameIdThenShapeId);
        const split = members.find(
          (entry, index) =>
            index > 0 && diagnostic.shapeIds.includes(entry.shapeId),
        );
        const stepIndex = doc.steps.findIndex(
          (step) => step.id === diagnostic.stepId,
        );
        if (split == null || stepIndex < 0) {
          return;
        }
        const insertion = makeInsertionSpace(
          doc.steps.map((step) => ({ id: step.id, key: step.orderKey })),
          stepIndex + 1,
        );
        editor.run(() => {
          applyStepKeyUpdates(insertion.updates);
          writeFrame(split.shapeId as TLShapeId, {
            ...split.frame,
            stepId: uniqueId(),
            stepOrderKey: insertion.insertedKey,
          });
        });
        return;
      }
    }
  };

  const handleReattachDetached = (
    diagnostic: Extract<TimelineDiagnostic, { type: "detached-sub-frame" }>,
  ) => {
    if (selectedCue == null) {
      return;
    }
    const shape = editor.getShape(diagnostic.shapeId as TLShapeId);
    const frame = shape != null ? getStoredFrame(shape) : null;
    if (shape == null || frame?.type !== "sub") {
      return;
    }
    // Append after the target batch's last sub frame.
    const position = findFramePosition(doc, selectedCue.frame.id);
    const lastSubFrameData = position?.batch.frames.slice(1).at(-1);
    let lastSubKey: string | null = null;
    if (lastSubFrameData != null) {
      const lastShape = editor.getShape(lastSubFrameData.shapeId as TLShapeId);
      const lastFrame = lastShape != null ? getStoredFrame(lastShape) : null;
      lastSubKey = lastFrame?.type === "sub" ? lastFrame.orderKey : null;
    }
    writeFrame(shape.id, {
      ...frame,
      cueFrameId: selectedCue.frame.id,
      orderKey: interactiveKeyAbove(lastSubKey),
    });
  };

  return (
    <div
      className={styles.panelContainer}
      // NOTE: pointerEvents: "all" and stopEventPropagation are needed to make this UI clickable on the tldraw app.
      style={{
        pointerEvents: "all",
      }}
      onPointerDown={(e) => stopEventPropagation(e)}
    >
      <div>
        <button
          className={styles.playButton}
          onClick={() => {
            onPresentationModeEnter();
          }}
        >
          ▶️
        </button>
      </div>

      <div className={styles.scrollableContainer}>
        <Timeline
          timelineDoc={doc}
          onEditedStepsChange={handleEditedStepsChange}
          onFrameChange={handleFrameChange}
          currentStepIndex={currentStepIndex}
          onStepSelect={onCurrentStepIndexChange}
          shapeSelections={shapeSelections}
          onFrameSelect={handleFrameSelect}
          onDiagnosticSelect={handleDiagnosticSelect}
          onResolveDiagnostic={handleResolveDiagnostic}
          onReattachDetached={handleReattachDetached}
          canReattachDetached={selectedCue != null}
          showAttachCueFrameButton={
            selectedAnimeFrameAttachableShapes.length > 0
          }
          requestAttachCueFrame={() => {
            selectedAnimeFrameAttachableShapes.forEach((shape) => {
              if (shape.type !== SlideShapeType) {
                presentationManager.attachCueFrame(shape.id, {
                  type: "shapeAnimation",
                });
              }
            });
          }}
          requestCueFrameAddAfter={(prevCueFrame) => {
            const prevShape = editor.getShape(
              prevCueFrame.shapeId as TLShapeId,
            );
            const position = findFramePosition(doc, prevCueFrame.id);
            if (prevShape == null || position == null) {
              return;
            }

            // A fresh step directly after the previous cue's step.
            const insertion = makeInsertionSpace(
              doc.steps.map((s) => ({ id: s.id, key: s.orderKey })),
              position.stepIndex + 1,
            );
            const newCueFrame: CueFrame = {
              v: 2,
              id: uniqueId(),
              type: "cue",
              trackId: position.batch.trackId,
              stepId: uniqueId(),
              stepOrderKey: insertion.insertedKey,
              action: {
                type: prevCueFrame.action.type,
                duration: 1000,
              },
            };

            editor.run(
              () => {
                applyStepKeyUpdates(insertion.updates);
                const newShapeId = createShapeId();
                editor.createShape({
                  ...prevShape,
                  id: newShapeId,
                  x: prevShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
                  y: prevShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
                  meta: {
                    frame: frameToMetaJson(newCueFrame),
                  },
                });
                editor.select(newShapeId);
              },
              { history: "ignore" },
            );
          }}
          requestCueFrameAddAfterGroup={(shapeSelection) => {
            const selectedShapeId = shapeSelection.shapeId;

            // The last selected frame per track, and the latest step any
            // of them belongs to — the new step goes right after it.
            // Identified by SHAPE id (frame ids may be duplicated).
            const selectedLastFrameShapeIdPerTrack: Record<string, string> = {};
            let maxPrevStepIndex = -1;
            doc.steps.forEach((step, stepIndex) => {
              for (const batch of step.batches) {
                for (const frame of batch.frames) {
                  if (shapeSelection.frameShapeIds.includes(frame.shapeId)) {
                    selectedLastFrameShapeIdPerTrack[batch.trackId] =
                      frame.shapeId;
                    maxPrevStepIndex = Math.max(maxPrevStepIndex, stepIndex);
                  }
                }
              }
            });
            const selectedLastFrameShapeIdsInItsTrack = Object.values(
              selectedLastFrameShapeIdPerTrack,
            );

            const cloneShapeRecursively = (
              rootShapeId: TLShapeId,
              parentShapeId?: TLShapeId,
            ): { original: TLShape; copied: TLShape }[] => {
              const original = editor.getShape(rootShapeId);
              if (original == null) {
                return [];
              }

              const frame = getStoredFrame(original);
              const isShapeLastSelectedFrameInItsTrack =
                frame != null &&
                selectedLastFrameShapeIdsInItsTrack.includes(
                  original.id as string,
                );
              const shouldCopyThisShape =
                original.type === GroupShapeUtil.type ||
                isShapeLastSelectedFrameInItsTrack;

              if (shouldCopyThisShape) {
                const newShapeId = createShapeId();
                const isCopiedShapeRoot = parentShapeId === undefined;
                let copiedShapeX: number;
                let copiedShapeY: number;
                let copiedShapeRotation: number;
                if (isCopiedShapeRoot) {
                  const pageTransform = editor.getShapePageTransform(original);
                  const { x, y, rotation } = pageTransform.decomposed();
                  copiedShapeX = x + COPIED_SHAPE_POSITION_OFFSET.x;
                  copiedShapeY = y + COPIED_SHAPE_POSITION_OFFSET.y;
                  copiedShapeRotation = rotation;
                } else {
                  copiedShapeX = original.x;
                  copiedShapeY = original.y;
                  copiedShapeRotation = original.rotation;
                }
                const copied: TLShape = {
                  ...original,
                  id: newShapeId,
                  x: copiedShapeX,
                  y: copiedShapeY,
                  rotation: copiedShapeRotation,
                  parentId: parentShapeId ?? editor.getCurrentPageId(),
                };

                const copiedChildren = editor
                  .getSortedChildIdsForParent(rootShapeId)
                  .flatMap((childId) => {
                    return cloneShapeRecursively(childId, newShapeId);
                  });

                return [
                  { original: original, copied: copied },
                  ...copiedChildren,
                ];
              } else {
                return editor
                  .getSortedChildIdsForParent(rootShapeId)
                  .flatMap((childId) => {
                    return cloneShapeRecursively(childId, parentShapeId);
                  });
              }
            };

            const clonedShapes = cloneShapeRecursively(selectedShapeId);

            // One shared fresh step for the whole operation: the copies
            // are simultaneous with each other, on their originals' tracks
            // (continuing each track's keyframe sequence).
            const insertion = makeInsertionSpace(
              doc.steps.map((s) => ({ id: s.id, key: s.orderKey })),
              maxPrevStepIndex + 1,
            );
            const sharedStepId = uniqueId();

            const shapesToCreate: TLShape[] = [];
            for (const { original, copied } of clonedShapes) {
              if (original.type === GroupShapeUtil.type) {
                shapesToCreate.push(copied);
                continue;
              }
              const origFrame = getStoredFrame(original);
              const origPosition = origFrame
                ? findFramePosition(doc, origFrame.id)
                : null;
              if (origPosition == null) {
                shapesToCreate.push(copied);
                continue;
              }
              const newCueFrame: CueFrame = {
                v: 2,
                id: copied.id,
                type: "cue",
                trackId: origPosition.batch.trackId,
                stepId: sharedStepId,
                stepOrderKey: insertion.insertedKey,
                action: {
                  type: origFrame ? origFrame.action.type : "shapeAnimation",
                  duration: 1000,
                },
              };
              shapesToCreate.push({
                ...copied,
                meta: {
                  ...copied.meta,
                  frame: frameToMetaJson(newCueFrame),
                },
              });
            }

            editor.run(
              () => {
                applyStepKeyUpdates(insertion.updates);
                editor.createShapes(shapesToCreate);

                const rootCreatedShape = shapesToCreate.find(
                  (s) => s.parentId === editor.getCurrentPageId(),
                );
                if (rootCreatedShape) {
                  editor.select(rootCreatedShape);
                }
              },
              { history: "ignore" },
            );
          }}
          requestSubFrameAddAfter={(prevFrame) => {
            const prevShape = editor.getShape(prevFrame.shapeId as TLShapeId);
            const position = findFramePosition(doc, prevFrame.id);
            if (prevShape == null || position == null) {
              return;
            }

            // Sub frames of the batch with their stored order keys.
            const subEntries = position.batch.frames.slice(1).map((frame) => {
              const shape = editor.getShape(frame.shapeId as TLShapeId);
              const stored = shape != null ? getStoredFrame(shape) : null;
              return {
                id: frame.frameId,
                key: stored?.type === "sub" ? stored.orderKey : "",
                shapeId: frame.shapeId,
              };
            });
            // Insert after the previous frame (the cue = before all subs).
            const insertionIndex = position.frameIndex; // frames[0] is the cue
            const insertion = makeInsertionSpace(subEntries, insertionIndex);

            const newSubFrame: SubFrame = {
              v: 2,
              id: uniqueId(),
              type: "sub",
              cueFrameId: position.batch.frames[0].frameId,
              orderKey: insertion.insertedKey,
              action: {
                type: prevFrame.action.type,
                duration: 1000,
              },
            };

            editor.run(() => {
              for (const { id, key } of insertion.updates) {
                const entry = subEntries.find((e) => e.id === id);
                const shape = entry
                  ? editor.getShape(entry.shapeId as TLShapeId)
                  : null;
                const stored = shape ? getStoredFrame(shape) : null;
                if (shape && stored?.type === "sub") {
                  writeFrame(shape.id, { ...stored, orderKey: key });
                }
              }
              const newShapeId = createShapeId();
              editor.createShape({
                ...prevShape,
                id: newShapeId,
                x: prevShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
                y: prevShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
                meta: {
                  frame: frameToMetaJson(newSubFrame),
                },
              });
              editor.select(newShapeId);
            });
          }}
        />
      </div>
    </div>
  );
});
