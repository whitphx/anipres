import {
  track,
  stopEventPropagation,
  createShapeId,
  uniqueId,
  type Editor,
  GroupShapeUtil,
} from "tldraw";
import {
  runStep,
  attachCueFrame,
  cueFrameToJsonObject,
  type CueFrame,
  FrameBatch,
  getFramesFromFrameBatches,
  getFrame,
  frameToJsonObject,
  getFrameBatches,
  Frame,
  SubFrame,
  getShapeByFrameId,
} from "../models";
import { insertOrderedTrackItem } from "../ordered-track-item";
import { Timeline } from "../Timeline";
import styles from "./ControlPanel.module.scss";
import { SlideShapeType } from "../SlideShapeUtil";
import { EditorSignals } from "../editor-signals";

export interface ControlPanelProps {
  editor: Editor;
  $editorSignals: EditorSignals;
  currentStepIndex: number;
  onCurrentStepIndexChange: (newIndex: number) => void;
  onPresentationModeEnter: () => void;
}
export const ControlPanel = track((props: ControlPanelProps) => {
  const {
    editor,
    $editorSignals,
    currentStepIndex,
    onCurrentStepIndexChange,
    onPresentationModeEnter,
  } = props;

  const steps = $editorSignals.getOrderedSteps();

  const frames = $editorSignals.getAllFrames();
  const frameBatches = getFrameBatches(frames);

  const selectedShapes = editor.getSelectedShapes();

  const selectedFrameIds = selectedShapes
    .map((shape) => {
      if (shape.type === GroupShapeUtil.type) {
        return editor
          .getSortedChildIdsForParent(shape.id)
          .map((childShapeId) => {
            const childShape = editor.getShape(childShapeId);
            if (childShape == null) {
              return null;
            }

            return getFrame(childShape)?.id;
          })
          .filter((id) => id != null);
      }

      return getFrame(shape)?.id;
    })
    .filter((frameId) => frameId != null)
    .flat();

  const selectedAnimeFrameAttachableShapes = selectedShapes
    .map((shape) => {
      if (shape.type === SlideShapeType) {
        return null;
      }

      if (shape.type === GroupShapeUtil.type) {
        const childShapeIds = editor.getSortedChildIdsForParent(shape.id);
        const childShapes = childShapeIds
          .map((id) => editor.getShape(id))
          .filter((shape) => shape != null);
        const everyChildShapeHasNoFrame = childShapes.every(
          (childShape) => getFrame(childShape) == null,
        );
        return everyChildShapeHasNoFrame ? shape : null;
      }

      const frame = getFrame(shape);
      return frame == null ? shape : null;
    })
    .filter((shape) => shape != null);

  const handleFrameChange = (newFrame: Frame) => {
    const shape = editor
      .getCurrentPageShapes()
      .find((shape) => getFrame(shape)?.id === newFrame.id);
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
    const newFrames = getFramesFromFrameBatches(newFrameBatches);

    const allShapes = editor.getCurrentPageShapes();

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
    const allShapes = editor.getCurrentPageShapes();
    const targetShapes = allShapes.filter(
      (shape) => getFrame(shape)?.id === frameId,
    );
    editor.select(...targetShapes);
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
          onStepSelect={(i) => {
            const res = runStep(editor, steps, i);
            if (res) {
              onCurrentStepIndexChange(i);
            }
          }}
          selectedFrameIds={selectedFrameIds}
          onFrameSelect={handleFrameSelect}
          showAttachCueFrameButton={
            selectedAnimeFrameAttachableShapes.length > 0
          }
          requestAttachCueFrame={() => {
            selectedAnimeFrameAttachableShapes.forEach((shape) => {
              if (shape.type !== SlideShapeType) {
                attachCueFrame(editor, shape.id, { type: "shapeAnimation" });
              }
            });
          }}
          requestCueFrameAddAfter={(prevCueFrame) => {
            const prevShape = getShapeByFrameId(editor, prevCueFrame.id);
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
          requestSubFrameAddAfter={(prevFrame) => {
            const prevShape = getShapeByFrameId(editor, prevFrame.id);
            if (prevShape == null) {
              return;
            }

            const newSubFrame: SubFrame = {
              id: uniqueId(),
              type: "sub",
              prevFrameId: prevFrame.id,
              action: {
                type: "shapeAnimation",
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
