import {
  track,
  stopEventPropagation,
  createShapeId,
  uniqueId,
  type Editor,
  GroupShapeUtil,
  TLShapeId,
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
  newTrackId,
  FrameAction,
} from "../models";
import { insertOrderedTrackItem } from "../ordered-track-item";
import { Timeline, type ShapeSelection } from "../Timeline";
import styles from "./ControlPanel.module.scss";
import { SlideShapeType } from "../SlideShapeUtil";
import type { PresentationManager } from "../presentation-manager";

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
                  x: prevShape.x + 100,
                  y: prevShape.y + 100,
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

            let newFrameBatches: FrameBatch<FrameAction>[] | undefined =
              undefined;

            const copyShape = (
              origShapeId: TLShapeId,
              newParentShapeId: TLShapeId | undefined = undefined,
            ): TLShapeId | undefined => {
              const origShape = editor.getShape(origShapeId);
              if (origShape == null) {
                return;
              }

              const shouldAttachFrame = origShape.type !== GroupShapeUtil.type;

              let newCueFrame: CueFrame | undefined = undefined;
              if (shouldAttachFrame) {
                const origFrame = getFrame(origShape);
                const prevCueFrame = origFrame
                  ? presentationManager.$getAssociatedCueFrames()[origFrame.id]
                  : undefined;

                newCueFrame = {
                  id: uniqueId(),
                  type: "cue",
                  globalIndex: steps.length + 999999, // NOTE: This will be recalculated later.
                  trackId: prevCueFrame ? prevCueFrame.trackId : newTrackId(),
                  action: {
                    type: origFrame ? origFrame.action.type : "shapeAnimation",
                    duration: 1000,
                  },
                };
                const newFrameBatch: FrameBatch = {
                  id: `batch-${newCueFrame.id}`,
                  globalIndex: newCueFrame.globalIndex,
                  trackId: newCueFrame.trackId,
                  data: [newCueFrame],
                };
                newFrameBatches = insertOrderedTrackItem(
                  frameBatches,
                  newFrameBatch,
                  prevCueFrame
                    ? prevCueFrame.globalIndex + 1
                    : presentationManager.$getNextGlobalIndex(),
                );
                for (const batch of newFrameBatches) {
                  batch.data[0].globalIndex = batch.globalIndex;
                }
              }

              const newShapeId = createShapeId();
              const newMeta = newCueFrame
                ? {
                    frame: frameToJsonObject(newCueFrame),
                  }
                : {};
              const isRoot = newParentShapeId === undefined;
              if (isRoot) {
                const pageBounds = editor.getShapePageBounds(origShape);
                const pageX = pageBounds ? pageBounds.x : 0;
                const pageY = pageBounds ? pageBounds.y : 0;
                editor.createShape({
                  ...origShape,
                  id: newShapeId,
                  x: pageX + 100,
                  y: pageY + 100,
                  parentId: editor.getCurrentPageId(),
                  meta: newMeta,
                });
              } else {
                editor.createShape({
                  ...origShape,
                  id: newShapeId,
                  x: origShape.x,
                  y: origShape.y,
                  parentId: newParentShapeId,
                  meta: newMeta,
                });
              }

              editor
                .getSortedChildIdsForParent(origShapeId)
                .forEach((childId) => {
                  copyShape(childId, newShapeId);
                });

              return newShapeId;
            };

            editor.run(
              () => {
                const copiedShapeId = copyShape(selectedShapeId);

                if (copiedShapeId) {
                  editor.select(copiedShapeId);
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
              x: prevShape.x + 100,
              y: prevShape.y + 100,
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
