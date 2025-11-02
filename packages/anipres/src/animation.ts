import {
  type Atom,
  type Editor,
  GroupShapeUtil,
  type TLShapeId,
  type TldrawBaseProps,
  computed,
  EASINGS,
  createShapeId,
  type TLShape,
} from "tldraw";
import { getFrame, getShapeByFrameId, type Frame, type Step } from "./models";
import { SlideShapeType } from "./SlideShapeUtil";
import type { EditorSignals } from "./editor-signals";

type ShapeVisibility = NonNullable<
  ReturnType<NonNullable<TldrawBaseProps["getShapeVisibility"]>>
>;

export class AnimationController {
  constructor(
    private editor: Editor,
    private $editorSignals: EditorSignals,
    private $currentStepIndex: Atom<number>,
  ) {}

  public moveTo(stepIndex: number) {
    if (stepIndex < 0) {
      stepIndex = 0;
    }
    const orderedSteps = this.$editorSignals.getOrderedSteps();
    if (orderedSteps.length === 0) {
      // No steps to animate
      return;
    }
    if (stepIndex >= orderedSteps.length) {
      stepIndex = orderedSteps.length - 1;
    }

    if (stepIndex === this.$currentStepIndex.get()) {
      return;
    }

    this.$currentStepIndex.set(stepIndex);
    runStep(this.editor, orderedSteps, stepIndex);
  }

  public rerunStep(): void {
    const stepIndex = this.$currentStepIndex.get();
    const orderedSteps = this.$editorSignals.getOrderedSteps();
    if (stepIndex < 0 || stepIndex >= orderedSteps.length) {
      return;
    }
    runStep(this.editor, orderedSteps, stepIndex);
  }

  @computed $getShapeVisibilitiesInPresentationMode(): Record<
    TLShapeId,
    ShapeVisibility
  > {
    const editor = this.editor;

    const orderedSteps = this.$editorSignals.getOrderedSteps();
    const currentStepIndex = this.$currentStepIndex.get();

    const shapes = editor.getCurrentPageShapes();
    const shapesVisibilities = shapes.map<[TLShapeId, ShapeVisibility]>(
      (shape) => {
        const shapeId = shape.id;

        const parent = editor.getShape(shape.parentId);
        if (parent?.type === GroupShapeUtil.type) {
          return [shapeId, "inherit"];
        }

        if (shape.type === SlideShapeType) {
          return [shapeId, "hidden"];
        }

        if (shape.meta?.hiddenDuringAnimation) {
          return [shapeId, "hidden"];
        }

        const frame = getFrame(shape);
        if (frame == null) {
          // No animation frame is attached to this shape, so it should always be visible
          return [shapeId, "visible"];
        }

        // The last frame of a finished animation should always be visible
        if (frame.type === "cue") {
          const cueFrame = frame;
          const isFuture = cueFrame.globalIndex > currentStepIndex;
          if (isFuture) {
            return [shapeId, "hidden"];
          }

          const lastBatchIncludingThisTrack = orderedSteps
            .slice(0, currentStepIndex + 1)
            .reverse()
            .flat()
            .find((ab) => ab.trackId === cueFrame.trackId);
          const isLatestPrevInTrack =
            lastBatchIncludingThisTrack &&
            lastBatchIncludingThisTrack.data.findIndex(
              (frame) => frame.id === cueFrame.id,
            ) ===
              lastBatchIncludingThisTrack.data.length - 1;
          if (isLatestPrevInTrack) {
            return [shapeId, "visible"];
          }
        } else if (frame.type === "sub") {
          const subFrame = frame;
          const thisBatch = orderedSteps
            .flat()
            .find((ab) => ab.data.some((frame) => frame.id === subFrame.id));
          if (thisBatch == null) {
            // This should never happen, but just in case
            return [shapeId, "hidden"];
          }

          const isFuture = thisBatch.globalIndex > currentStepIndex;
          if (isFuture) {
            return [shapeId, "hidden"];
          }

          const lastBatchIncludingThisTrack = orderedSteps
            .slice(0, currentStepIndex + 1)
            .reverse()
            .flat()
            .find((ab) => ab.trackId === thisBatch.trackId);
          const isLatestPrevInTrack =
            lastBatchIncludingThisTrack &&
            lastBatchIncludingThisTrack.data.findIndex(
              (frame) => frame.id === subFrame.id,
            ) ===
              lastBatchIncludingThisTrack.data.length - 1;
          if (isLatestPrevInTrack) {
            return [shapeId, "visible"];
          }
        }

        // Hidden by default
        return [shapeId, "hidden"];
      },
    );

    return Object.fromEntries(shapesVisibilities);
  }
}

async function runFrames(
  editor: Editor,
  frames: Frame[],
  predecessorShape: TLShape | null,
  historyStoppingPoint: string,
): Promise<void> {
  for (const frame of frames) {
    const shape = getShapeByFrameId(editor, frame.id);
    if (shape == null) {
      throw new Error(`Shape not found for frame ${frame.id}`);
    }

    const action = frame.action;

    const { duration = 0, easing = "easeInCubic" } = action;
    const immediate = duration === 0;

    if (action.type === "cameraZoom") {
      const { inset = 0 } = action;

      editor.stopCameraAnimation();
      const bounds = editor.getShapePageBounds(shape);
      if (!bounds) {
        throw new Error(`Bounds not found for shape ${shape.id}`);
      }
      editor.selectNone();
      editor.zoomToBounds(bounds, {
        inset,
        immediate,
        animation: { duration, easing: EASINGS[easing] },
      });
    } else if (action.type === "shapeAnimation") {
      editor.selectNone();

      if (predecessorShape == null) {
        predecessorShape = shape;
        continue;
      }

      // Create and manipulate a temporary shape for animation
      const animeShapeId = createShapeId();
      editor.run(
        () => {
          editor.createShape({
            ...predecessorShape,
            id: animeShapeId,
            type: shape.type,
            meta: undefined,
          });
        },
        { history: "ignore", ignoreShapeLock: true },
      );

      // HACK: Changes made by editor.animateShape() can't be ignored by `editor.run(..., { history: "ignore" })`
      // because it's done in the `tick` event listener that is executed after the `editor.run()` returns.
      // So we need to cancel the history records in another `tick` event listener manually.
      const onTick = () => {
        editor.bailToMark(historyStoppingPoint);
      };
      editor.on("tick", onTick);
      editor.animateShape(
        {
          ...shape,
          id: animeShapeId,
          meta: undefined,
        },
        {
          immediate,
          animation: {
            duration,
            easing: EASINGS[easing],
          },
        },
      );

      setTimeout(() => {
        editor.run(
          () => {
            editor.deleteShape(animeShapeId);
          },
          { history: "ignore", ignoreShapeLock: true },
        );
        editor.off("tick", onTick);
      }, duration);
    }

    await new Promise((resolve) => setTimeout(resolve, duration));

    predecessorShape = shape;
  }
}

function runStep(editor: Editor, steps: Step[], index: number): boolean {
  const step = steps[index];
  if (step == null) {
    return false;
  }

  const markBeforeAnimation = editor.markHistoryStoppingPoint();

  step.forEach((frameBatch) => {
    const predecessorFrameBatch = steps
      .slice(0, index)
      .reverse()
      .flat()
      .find((fb) => fb.trackId === frameBatch.trackId);
    const predecessorLastFrame = predecessorFrameBatch?.data.at(-1);
    const predecessorShape =
      predecessorLastFrame != null
        ? getShapeByFrameId(editor, predecessorLastFrame.id)
        : null;

    const frames = frameBatch.data;
    const frameShapes = frames
      .map((frame) => getShapeByFrameId(editor, frame.id))
      .filter((shape) => shape != null);

    editor.run(
      () => {
        for (const shape of frameShapes) {
          editor.updateShape({
            id: shape.id,
            type: shape.id,
            meta: {
              ...shape.meta,
              hiddenDuringAnimation: true,
            },
          });
        }
      },
      { history: "ignore", ignoreShapeLock: true },
    );

    runFrames(
      editor,
      frames,
      predecessorShape ?? null,
      markBeforeAnimation,
    ).finally(() => {
      editor.run(
        () => {
          for (const shape of frameShapes) {
            editor.updateShape({
              id: shape.id,
              type: shape.id,
              meta: {
                ...shape.meta,
                hiddenDuringAnimation: false,
              },
            });
          }
        },
        { history: "ignore", ignoreShapeLock: true },
      );
      editor.bailToMark(markBeforeAnimation);
    });
  });

  return true;
}
