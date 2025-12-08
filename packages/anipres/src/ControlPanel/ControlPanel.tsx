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
  type Frame,
  type CueFrame,
  type SubFrame,
  type FrameBatch,
  frameToJsonObject,
  cueFrameToJsonObject,
  getFrame,
  getFrameBatches,
  getLeafShapes,
  FrameAction,
} from "../models";
import { insertOrderedTrackItem } from "../ordered-track-item";
import { Timeline, type ShapeSelection } from "../Timeline";
import styles from "./ControlPanel.module.scss";
import { SlideShapeType } from "../shapes/slide/SlideShapeUtil";
import type { PresentationManager } from "../presentation-manager";

const COPIED_SHAPE_POSITION_OFFSET = { x: 100, y: 100 };

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

  const steps = presentationManager.$getOrderedSteps();

  const frames = presentationManager.$getAllFrames();
  const frameBatches = getFrameBatches(frames);

  const selectedShapes = editor.getSelectedShapes();

  const shapeSelections: ShapeSelection[] = selectedShapes.map((shape) => {
    const leafShapes = getLeafShapes(editor, shape);
    const leafFrames = leafShapes
      .map(getFrame)
      .filter((frame): frame is Frame => frame != null);
    return {
      shapeId: shape.id,
      frameIds: leafFrames.map((frame) => frame.id),
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
          (leafShape) => getFrame(leafShape) == null,
        );
        return everyLeafShapeHasNoFrame ? shape : null;
      }

      const frame = getFrame(shape);
      return frame == null ? shape : null;
    })
    .filter((shape) => shape != null);

  const handleFrameChange = (newFrame: Frame) => {
    const shape = presentationManager.getShapeByFrameId(newFrame.id);
    if (shape == null) {
      return;
    }

    editor.updateShape({
      ...shape,
      meta: {
        frame: frameToJsonObject(newFrame),
      },
    });
  };

  const handleFrameBatchesChange = (newFrameBatches: FrameBatch[]) => {
    const newFrames = newFrameBatches.flatMap((batch) => batch.data);

    const allShapes = presentationManager.$getCurrentPageDescendantShapes();

    const updateShapePartials = allShapes.map((shape) => {
      const newFrame = newFrames.find(
        (newFrame) => newFrame.id === getFrame(shape)?.id,
      );
      if (newFrame == null) {
        const metaCopy = { ...shape.meta };
        delete metaCopy.frame;
        return {
          ...shape,
          meta: metaCopy,
        };
      }

      return {
        ...shape,
        meta: {
          ...shape.meta,
          frame: frameToJsonObject(newFrame),
        },
      };
    });

    editor.updateShapes(updateShapePartials);
  };

  const handleFrameSelect = (frameId: string) => {
    const targetShape = presentationManager.getShapeByFrameId(frameId);
    if (targetShape) {
      editor.select(targetShape);
    }
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
          frameBatches={frameBatches}
          onFrameBatchesChange={handleFrameBatchesChange}
          onFrameChange={handleFrameChange}
          currentStepIndex={currentStepIndex}
          onStepSelect={onCurrentStepIndexChange}
          shapeSelections={shapeSelections}
          onFrameSelect={handleFrameSelect}
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
            const prevShape = presentationManager.getShapeByFrameId(
              prevCueFrame.id,
            );
            if (prevShape == null) {
              return;
            }

            const newCueFrame: CueFrame = {
              id: uniqueId(),
              type: "cue",
              globalIndex: steps.length + 999999, // NOTE: This will be recalculated later.
              trackId: prevCueFrame.trackId,
              action: {
                type: prevCueFrame.action.type,
                duration: 1000,
              },
            };
            const newFrameBatch: FrameBatch = {
              id: `batch-${newCueFrame.id}`,
              globalIndex: newCueFrame.globalIndex,
              trackId: newCueFrame.trackId,
              data: [newCueFrame],
            };
            const newFrameBatches = insertOrderedTrackItem(
              frameBatches,
              newFrameBatch,
              prevCueFrame.globalIndex + 1,
            );
            for (const batch of newFrameBatches) {
              batch.data[0].globalIndex = batch.globalIndex;
            }

            editor.run(
              () => {
                const newShapeId = createShapeId();
                editor.createShape({
                  ...prevShape,
                  id: newShapeId,
                  x: prevShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
                  y: prevShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
                  meta: {
                    frame: cueFrameToJsonObject(newCueFrame),
                  },
                });
                editor.select(newShapeId);

                handleFrameBatchesChange(newFrameBatches);
              },
              { history: "ignore" },
            );
          }}
          requestCueFrameAddAfterGroup={(shapeSelection) => {
            const selectedShapeId = shapeSelection.shapeId;

            const orderedSteps = presentationManager.$getOrderedSteps();
            const selectedLastFrameIdsPerTrack: Record<string, string> = {};
            for (const step of orderedSteps) {
              for (const frameBatch of step) {
                for (const frame of frameBatch.data) {
                  if (shapeSelection.frameIds.includes(frame.id)) {
                    selectedLastFrameIdsPerTrack[frameBatch.trackId] = frame.id;
                  }
                }
              }
            }
            const selectedLastFrameIdsInItsTrack = Object.values(
              selectedLastFrameIdsPerTrack,
            );

            const cloneShapeRecursively = (
              rootShapeId: TLShapeId,
              parentShapeId?: TLShapeId,
            ): { original: TLShape; copied: TLShape }[] => {
              const original = editor.getShape(rootShapeId);
              if (original == null) {
                return [];
              }

              const frame = getFrame(original);
              const isShapeLastSelectedFrameInItsTrack =
                frame && selectedLastFrameIdsInItsTrack.includes(frame.id);
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
            const clonedShapeAndFrames = clonedShapes.map(
              ({ original, copied }) => {
                const shouldAttachFrame = original.type !== GroupShapeUtil.type;
                if (!shouldAttachFrame) {
                  return {
                    original,
                    copied,
                    origFrame: null,
                    prevCueFrame: null,
                  };
                }

                const origFrame = getFrame(original);
                const prevCueFrame = origFrame
                  ? presentationManager.$getAssociatedCueFrames()[origFrame.id]
                  : undefined;
                return { original, copied, origFrame, prevCueFrame };
              },
            );

            const prevCueFrameGlobalIndexes = clonedShapeAndFrames
              .map(({ prevCueFrame }) => prevCueFrame)
              .filter((f): f is CueFrame => f != null)
              .map((f) => f.globalIndex);
            const nextGlobalIndex =
              prevCueFrameGlobalIndexes.length > 0
                ? Math.max(...prevCueFrameGlobalIndexes) + 1
                : presentationManager.$getNextGlobalIndex();

            let newFrameBatches: FrameBatch<FrameAction>[] | undefined =
              undefined;
            clonedShapeAndFrames.forEach(
              ({ copied, origFrame, prevCueFrame }) => {
                if (prevCueFrame == null) {
                  return;
                }

                const newCueFrame: CueFrame = {
                  id: copied.id,
                  type: "cue",
                  globalIndex: nextGlobalIndex,
                  trackId: prevCueFrame.trackId,
                  action: {
                    type: origFrame ? origFrame.action.type : "shapeAnimation",
                    duration: 1000,
                  },
                };

                copied.meta = {
                  ...copied.meta,
                  frame: frameToJsonObject(newCueFrame),
                };

                const newFrameBatch: FrameBatch = {
                  id: `batch-${newCueFrame.id}`,
                  globalIndex: nextGlobalIndex,
                  trackId: newCueFrame.trackId,
                  data: [newCueFrame],
                };
                if (newFrameBatches == null) {
                  newFrameBatches = insertOrderedTrackItem(
                    frameBatches,
                    newFrameBatch,
                    nextGlobalIndex,
                  );
                } else {
                  newFrameBatches.push(newFrameBatch);
                }
              },
            );

            const shapesToCreate = clonedShapeAndFrames.map(
              ({ copied }) => copied,
            );
            editor.run(
              () => {
                editor.createShapes(shapesToCreate);

                const rootCreatedShape = shapesToCreate.find(
                  (s) => s.parentId === editor.getCurrentPageId(),
                );
                if (rootCreatedShape) {
                  editor.select(rootCreatedShape);
                }
                if (newFrameBatches) {
                  handleFrameBatchesChange(newFrameBatches);
                }
              },
              { history: "ignore" },
            );
          }}
          requestSubFrameAddAfter={(prevFrame) => {
            const prevShape = presentationManager.getShapeByFrameId(
              prevFrame.id,
            );
            if (prevShape == null) {
              return;
            }

            const newSubFrame: SubFrame = {
              id: uniqueId(),
              type: "sub",
              prevFrameId: prevFrame.id,
              action: {
                type: prevFrame.action.type,
                duration: 1000,
              },
            };

            const newShapeId = createShapeId();
            editor.createShape({
              ...prevShape,
              id: newShapeId,
              x: prevShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
              y: prevShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
              meta: {
                frame: frameToJsonObject(newSubFrame),
              },
            });
            editor.select(newShapeId);
          }}
        />
      </div>
    </div>
  );
});
