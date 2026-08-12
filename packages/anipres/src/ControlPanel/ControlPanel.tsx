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
  makeInsertionSpace,
  orderKeyBetween,
  parseFrameMeta,
  planDuplicateFrameIdRepair,
  reconcileEditedSteps,
  type CueFrame,
  type EditedStep,
  type Frame,
  type SubFrame,
  type TimelineDiagnostic,
} from "../timeline-model";
import { getLeafShapes } from "../models";
import type { FrameUIData } from "../Timeline/frame-ui-data";
import { Timeline, type ShapeSelection } from "../Timeline";
import styles from "./ControlPanel.module.scss";
import { SlideShapeType } from "../shapes/slide/SlideShape";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import type { PresentationManager } from "../presentation-manager";
import {
  findFramePosition,
  followupActionFrom,
  planDetachedReattach,
  planSameTrackSplitMaterialization,
  planStepKeyAlignment,
  planSubFrameAddAfter,
} from "./operations";

const COPIED_SHAPE_POSITION_OFFSET = { x: 100, y: 100 };

/**
 * Whether a frame sequence may grow via the timeline's per-batch "+"
 * buttons, which clone the previous carrier shape. The exclusion is by
 * ACTION, not carrier type — markers are safe to clone (the group path
 * does), but media events are added via "+ Media event" and chained by
 * dragging one onto an earlier step. A video carrier is now an ordinary
 * one: cloning it makes a movement keyframe, not a second player.
 */
function canExtendFrameSequenceFrom(frame: FrameUIData): boolean {
  return frame.action.type !== "mediaControl";
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

  const getStoredFrameByShapeId = (shapeId: string): Frame | null => {
    const shape = editor.getShape(shapeId as TLShapeId);
    return shape != null ? getStoredFrame(shape) : null;
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

  const selectedYouTubeEmbedShapes = selectedShapes.filter(isYouTubeEmbedShape);

  const selectedAnimeFrameAttachableShapes = selectedShapes
    .map((shape) => {
      if (
        shape.type === SlideShapeType ||
        // Markers exist solely to carry a media frame; attaching a
        // shapeAnimation cue to one makes no sense.
        shape.type === MediaControlShapeType
      ) {
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
   * Keyed by STORED stepId, so the write reaches EVERY cue sharing the
   * step identity — including split members displayed under synthetic
   * recovery steps — and a normalization can never re-key a step away
   * from its unresolved split siblings.
   */
  const applyStepKeyUpdates = (updates: { id: string; key: string }[]) => {
    if (updates.length === 0) return;
    const frames = collectStoredFrames();
    for (const { id: stepId, key } of updates) {
      for (const entry of frames) {
        if (
          entry.frame.type === "cue" &&
          entry.frame.stepId === stepId &&
          entry.frame.stepOrderKey !== key
        ) {
          writeFrame(entry.shapeId as TLShapeId, {
            ...entry.frame,
            stepOrderKey: key,
          });
        }
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

  // Deleting a media event means deleting its (invisible) marker shape;
  // the frame disappears from the timeline with it. The type check is
  // the invariant that only marker shapes may be deleted through this
  // path — for any other carrier it would destroy a user's drawing.
  const handleFrameDelete = (frame: FrameUIData) => {
    const targetShape = editor.getShape(frame.shapeId as TLShapeId);
    if (targetShape?.type === MediaControlShapeType) {
      editor.deleteShape(targetShape.id);
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
      case "v1-frame":
        // Destructive by design: this version cannot convert v1 data,
        // so the only resolution is deleting it (labeled accordingly).
        editor.run(() => {
          for (const shapeId of diagnostic.shapeIds) {
            clearFrame(shapeId as TLShapeId);
          }
        });
        return;
      case "step-key-divergence": {
        // Explicit "align step keys" repair — the only path that
        // persists this convergence.
        const alignment = planStepKeyAlignment({
          currentFrames: collectStoredFrames(),
          stepId: diagnostic.stepId,
        });
        editor.run(() => {
          for (const update of alignment) {
            writeFrame(update.shapeId as TLShapeId, update.frame);
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
        // Explicit "materialize split" repair — the only path that
        // persists the split into a stored step.
        const plan = planSameTrackSplitMaterialization({
          doc,
          currentFrames: collectStoredFrames(),
          stepId: diagnostic.stepId,
          trackId: diagnostic.trackId,
          shapeIds: diagnostic.shapeIds,
          mintId: uniqueId,
        });
        if (plan == null) {
          return;
        }
        editor.run(() => {
          applyStepKeyUpdates(plan.stepKeyUpdates);
          writeFrame(
            plan.splitUpdate.shapeId as TLShapeId,
            plan.splitUpdate.frame,
          );
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
    // Append after the target batch's last sub frame. The target batch is
    // located by the selected cue's SHAPE id — with duplicated stored
    // frame ids, the frame id would find the wrong batch.
    const plan = planDetachedReattach({
      doc,
      cueShapeId: selectedCue.shapeId as string,
      getStoredFrame: getStoredFrameByShapeId,
      mintId: uniqueId,
    });
    // The cue-id freshening (duplicate-id disambiguation) and the
    // reattachment must land in ONE transaction.
    editor.run(() => {
      if (plan?.cueFrameUpdate != null) {
        writeFrame(
          plan.cueFrameUpdate.shapeId as TLShapeId,
          plan.cueFrameUpdate.frame,
        );
      }
      writeFrame(
        shape.id,
        plan != null
          ? { ...frame, cueFrameId: plan.cueFrameId, orderKey: plan.orderKey }
          : {
              ...frame,
              cueFrameId: selectedCue.frame.id,
              orderKey: orderKeyBetween(null, null),
            },
      );
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
      <div className={styles.actionButtons}>
        <button
          className={styles.playButton}
          onClick={() => {
            onPresentationModeEnter();
          }}
        >
          ▶️
        </button>
        {selectedYouTubeEmbedShapes.length > 0 && (
          <button
            type="button"
            className={styles.playButton}
            title="Add a playback event (play, pause, …) for the selected video as a new step"
            onClick={() => {
              // One event per video, not per carrier: a video that
              // moves is several carriers, and selecting two of them is
              // still one request about one video.
              const byVideo = new Map(
                selectedYouTubeEmbedShapes.map((shape) => [
                  getVideoKey(shape),
                  shape,
                ]),
              );
              byVideo.forEach((shape) => {
                presentationManager.attachMediaControlCueFrame(shape.id);
              });
            }}
          >
            + Media event
          </button>
        )}
      </div>

      <div className={styles.scrollableContainer}>
        <Timeline
          timelineDoc={doc}
          trackGroups={presentationManager.$getMediaTrackGroups()}
          canExtendFrameSequence={(cueFrame) =>
            canExtendFrameSequenceFrom(cueFrame)
          }
          onEditedStepsChange={handleEditedStepsChange}
          onFrameChange={handleFrameChange}
          onFrameDelete={handleFrameDelete}
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
            // Locate by SHAPE id: with duplicated stored frame ids, the
            // frame id could resolve to another frame's step/track.
            const position = findFramePosition(doc, prevCueFrame.shapeId);
            if (
              prevShape == null ||
              position == null ||
              // The buttons are hidden for these frames; the guard keeps
              // the invariant local to the operation.
              !canExtendFrameSequenceFrom(prevCueFrame)
            ) {
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
              action: followupActionFrom(prevCueFrame.action),
            };

            editor.run(
              () => {
                applyStepKeyUpdates(insertion.updates);
                const source = editor.getShape(prevShape.id) ?? prevShape;
                const newShapeId = createShapeId();
                editor.createShape({
                  ...source,
                  id: newShapeId,
                  x: source.x + COPIED_SHAPE_POSITION_OFFSET.x,
                  y: source.y + COPIED_SHAPE_POSITION_OFFSET.y,
                  meta: {
                    ...source.meta,
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
              // Source position from the SHAPE id, never the stored
              // frame id (which may be duplicated).
              const origPosition = origFrame
                ? findFramePosition(doc, original.id as string)
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
                action: origFrame
                  ? followupActionFrom(origFrame.action)
                  : { type: "shapeAnimation", duration: 1000 },
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
            // Plan keyed entirely by SHAPE ids — stored frame ids may be
            // duplicated within the batch.
            const plan = planSubFrameAddAfter({
              doc,
              prevShapeId: prevFrame.shapeId,
              getStoredFrame: getStoredFrameByShapeId,
              mintId: uniqueId,
            });
            if (
              prevShape == null ||
              plan == null ||
              !canExtendFrameSequenceFrom(prevFrame)
            ) {
              return;
            }

            const newSubFrame: SubFrame = {
              v: 2,
              id: uniqueId(),
              type: "sub",
              cueFrameId: plan.cueFrameId,
              orderKey: plan.orderKey,
              action: followupActionFrom(prevFrame.action),
            };

            editor.run(() => {
              // Cue-id freshening (duplicate-id disambiguation) shares the
              // transaction with the new sub frame's creation.
              if (plan.cueFrameUpdate != null) {
                writeFrame(
                  plan.cueFrameUpdate.shapeId as TLShapeId,
                  plan.cueFrameUpdate.frame,
                );
              }
              for (const { shapeId, key } of plan.keyUpdates) {
                const stored = getStoredFrameByShapeId(shapeId);
                if (stored?.type === "sub") {
                  writeFrame(shapeId as TLShapeId, {
                    ...stored,
                    orderKey: key,
                  });
                }
              }
              const source = editor.getShape(prevShape.id) ?? prevShape;
              const newShapeId = createShapeId();
              editor.createShape({
                ...source,
                id: newShapeId,
                x: source.x + COPIED_SHAPE_POSITION_OFFSET.x,
                y: source.y + COPIED_SHAPE_POSITION_OFFSET.y,
                meta: {
                  ...source.meta,
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
