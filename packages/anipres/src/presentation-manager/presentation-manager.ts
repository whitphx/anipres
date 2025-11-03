import {
  computed,
  type Editor,
  type Atom,
  type TLShape,
  type TLShapeId,
  type TldrawBaseProps,
  GroupShapeUtil,
} from "tldraw";
import {
  type Frame,
  type SubFrame,
  type Step,
  getFrame,
  getSubFrame,
  getFrames,
  getFrameBatches,
  cueFrameToJsonObject,
  subFrameToJsonObject,
} from "../models";
import {
  getGlobalOrder,
  reassignGlobalIndexInplace,
} from "../ordered-track-item";
import { SlideShapeType } from "../SlideShapeUtil";
import { runStep } from "./animation";

type ShapeVisibility = NonNullable<
  ReturnType<NonNullable<TldrawBaseProps["getShapeVisibility"]>>
>;

// Functions that depends on `editor` and should be cached by `computed` go here.
export class PresentationManager {
  private constructor(
    public readonly editor: Editor,
    private $currentStepIndex: Atom<number>,
  ) {}

  private static instances: WeakMap<Editor, PresentationManager> =
    new WeakMap();

  static create(
    editor: Editor,
    $currentStepIndex: Atom<number>,
  ): PresentationManager {
    let inst = this.instances.get(editor);
    if (!inst) {
      inst = new PresentationManager(editor, $currentStepIndex);
      this.instances.set(editor, inst);
    }
    return inst;
  }

  @computed $getAllFrames(): Frame[] {
    const shapes = this.editor.getCurrentPageShapes();
    return getFrames(shapes);
  }

  @computed $getOrderedSteps(): Step[] {
    const frames = this.$getAllFrames();
    const frameBatches = getFrameBatches(frames);
    const orderedSteps = getGlobalOrder(frameBatches);
    return orderedSteps;
  }

  @computed $getTotalSteps(): number {
    return this.$getOrderedSteps().length;
  }

  getShapeByFrameId(frameId: Frame["id"]): TLShape | undefined {
    const shapes = this.editor.getCurrentPageShapes();
    return shapes.find((shape) => getFrame(shape)?.id === frameId);
  }

  reconcileShapeDeletion(deletedShape: TLShape) {
    const deletedFrame = getFrame(deletedShape);
    if (deletedFrame == null) {
      return;
    }

    const editor = this.editor;

    if (deletedFrame.type === "cue") {
      // Reassign globalIndex
      const steps = this.$getOrderedSteps();
      reassignGlobalIndexInplace(steps);
      steps.forEach((stepFrameBatches) => {
        stepFrameBatches.forEach((frameBatch) => {
          const newGlobalIndex = frameBatch.globalIndex;
          const cueFrame = frameBatch.data[0];
          const shape = this.getShapeByFrameId(cueFrame.id);
          if (shape == null) {
            return;
          }
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            meta: {
              ...shape.meta,
              frame: cueFrameToJsonObject({
                ...cueFrame,
                globalIndex: newGlobalIndex,
              }),
            },
          });
        });
      });
    } else if (deletedFrame.type === "sub") {
      // Reassign prevFrameId
      const shapes = editor.getCurrentPageShapes();
      const allSubFrames = shapes
        .map((shape) => ({ shape, subFrame: getSubFrame(shape) }))
        .filter(({ subFrame }) => subFrame != null) as {
        shape: TLShape;
        subFrame: SubFrame;
      }[];
      allSubFrames.forEach(({ shape, subFrame }) => {
        if (subFrame.prevFrameId === deletedFrame.id) {
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            meta: {
              ...shape.meta,
              frame: subFrameToJsonObject({
                ...subFrame,
                prevFrameId: deletedFrame.prevFrameId,
              }),
            },
          });
        }
      });
    }
  }

  public moveTo(stepIndex: number): void;
  public moveTo(stepIndexUpdater: (prev: number) => number): void;
  public moveTo(stepIndexOrUpdater: number | ((prev: number) => number)): void {
    if (typeof stepIndexOrUpdater === "function") {
      const updater = stepIndexOrUpdater;
      const prevIndex = this.$currentStepIndex.get();
      const newIndex = updater(prevIndex);
      this._moveTo(newIndex);
      return;
    } else {
      const stepIndex = stepIndexOrUpdater;
      this._moveTo(stepIndex);
    }
  }

  private _moveTo(stepIndex: number) {
    if (stepIndex < 0) {
      stepIndex = 0;
    }
    const orderedSteps = this.$getOrderedSteps();
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
    runStep(this, orderedSteps, stepIndex);
  }

  public rerunStep(): void {
    const stepIndex = this.$currentStepIndex.get();
    const orderedSteps = this.$getOrderedSteps();
    if (stepIndex < 0 || stepIndex >= orderedSteps.length) {
      return;
    }
    runStep(this, orderedSteps, stepIndex);
  }

  @computed $getShapeVisibilitiesInPresentationMode(): Record<
    TLShapeId,
    ShapeVisibility
  > {
    const editor = this.editor;

    const orderedSteps = this.$getOrderedSteps();
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
            lastBatchIncludingThisTrack.data.length > 0 &&
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
            lastBatchIncludingThisTrack.data.length > 0 &&
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
