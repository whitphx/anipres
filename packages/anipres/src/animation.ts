import {
  Editor,
  GroupShapeUtil,
  TLShapeId,
  TldrawBaseProps,
  computed,
} from "tldraw";
import { getFrame } from "./models";
import { SlideShapeType } from "./SlideShapeUtil";
import type { AnipresAtoms } from "./Anipres";
import { EditorSignals } from "./editor-signals";

type ShapeVisibility = NonNullable<
  ReturnType<NonNullable<TldrawBaseProps["getShapeVisibility"]>>
>;

export class AnimationController {
  constructor(
    private editor: Editor,
    private $editorSignals: EditorSignals,
    private perInstanceAtoms: AnipresAtoms,
  ) {}

  @computed getShapeVisibilitiesInPresentationMode(): Record<
    TLShapeId,
    ShapeVisibility
  > {
    const editor = this.editor;

    const orderedSteps = this.$editorSignals.getOrderedSteps();
    const currentStepIndex = this.perInstanceAtoms.$currentStepIndex.get();

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
