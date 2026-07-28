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
  type FrameRecord,
  type StepData,
  type TimelineDoc,
  getFrame,
  getFrameRecords,
  cueFrameToJsonObject,
  CueFrame,
  FrameAction,
  getStepOrderKeyAfter,
  newStepId,
  newTrackId,
} from "../models";
import { deriveTimelineFromShapes } from "../legacy-models";
import { SlideShapeType } from "../shapes/slide/SlideShape";
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

  static get(editor: Editor): PresentationManager | undefined {
    return this.instances.get(editor);
  }

  @computed $getAllFrameRecords(): FrameRecord[] {
    return getFrameRecords(this.$getCurrentPageDescendantShapes());
  }

  @computed $getAllFrames(): Frame[] {
    return this.$getAllFrameRecords().map((record) => record.frame);
  }

  @computed $getTimeline(): TimelineDoc {
    return deriveTimelineFromShapes(
      this.$getCurrentPageDescendantShapes(),
      this.editor.getCurrentPageId(),
    );
  }

  @computed $getOrderedSteps(): StepData[] {
    return this.$getTimeline().steps;
  }

  @computed $getTotalSteps(): number {
    return this.$getOrderedSteps().length;
  }

  @computed $getAssociatedCueFrames(): Record<Frame["id"], CueFrame> {
    const steps = this.$getOrderedSteps();
    const associatedCueFrameIds: Record<Frame["id"], CueFrame> = {};
    for (const step of steps) {
      for (const batch of step.batches) {
        const cueShape = this.editor.getShape(batch.frames[0].shapeId);
        const cueFrame = cueShape ? getFrame(cueShape) : undefined;
        if (cueFrame?.type !== "cue") continue;
        for (const frame of batch.frames) {
          associatedCueFrameIds[frame.frameId] = cueFrame;
        }
      }
    }
    return associatedCueFrameIds;
  }

  attachCueFrame(shapeId: TLShapeId, frameAction: FrameAction) {
    const steps = this.$getOrderedSteps();
    const lastStoredStep = [...steps].reverse().find((step) => !step.synthetic);
    const lastCueShapeId = lastStoredStep?.batches[0]?.frames[0]?.shapeId;
    const lastCueShape = lastCueShapeId
      ? this.editor.getShape(lastCueShapeId)
      : undefined;
    const lastCueFrame = lastCueShape ? getFrame(lastCueShape) : undefined;
    const stepId = newStepId();
    const stepOrderKey = getStepOrderKeyAfter(
      lastCueFrame?.type === "cue" ? lastCueFrame.stepOrderKey : undefined,
    );

    const attachCueFrameToShape = (shapeId: TLShapeId) => {
      const shape = this.editor.getShape(shapeId);
      if (shape == null) {
        return;
      }

      if (shape.type === GroupShapeUtil.type) {
        const childIds = this.editor.getSortedChildIdsForParent(shape);
        for (const childId of childIds) {
          attachCueFrameToShape(childId);
        }
        return;
      }

      const cueFrame: CueFrame = {
        v: 2,
        id: shapeId,
        type: "cue",
        trackId: newTrackId(),
        stepId,
        stepOrderKey,
        action: frameAction,
      };
      this.editor.updateShape({
        id: shapeId,
        type: shape.type,
        meta: {
          ...shape.meta,
          frame: cueFrameToJsonObject(cueFrame),
        },
      });
    };

    this.editor.run(() => {
      attachCueFrameToShape(shapeId);
    });
  }

  @computed $getCurrentPageDescendantShapes(): TLShape[] {
    const getDescendantShapes = (ancestorShape: TLShape): TLShape[] => {
      if (ancestorShape.type !== GroupShapeUtil.type) {
        return [ancestorShape];
      }

      const childShapeIds = this.editor.getSortedChildIdsForParent(
        ancestorShape.id,
      );
      const childShapes = childShapeIds
        .map((id) => this.editor.getShape(id))
        .filter((shape) => shape != null);
      return [
        ancestorShape,
        ...childShapes.flatMap((childShape) => getDescendantShapes(childShape)),
      ];
    };

    const pageShapes = this.editor.getCurrentPageShapes();
    return pageShapes.flatMap((shape) => getDescendantShapes(shape));
  }

  getShapeByFrameId(frameId: Frame["id"]): TLShape | undefined {
    const pageDescendantShapes = this.$getCurrentPageDescendantShapes();
    return pageDescendantShapes
      .filter((shape) => getFrame(shape)?.id === frameId)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
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

    const pageDescendantShapes = this.$getCurrentPageDescendantShapes();
    const shapesVisibilities = pageDescendantShapes.map<
      [TLShapeId, ShapeVisibility]
    >((shape) => {
      const shapeId = shape.id;

      if (shape.type === SlideShapeType) {
        return [shapeId, "hidden"];
      }

      if (shape.meta?.hiddenDuringAnimation) {
        return [shapeId, "hidden"];
      }

      const frame = getFrame(shape);
      if (frame == null) {
        // No animation frame is attached to this shape, so it should always be visible
        const parent = editor.getShape(shape.parentId);
        if (parent?.type === GroupShapeUtil.type) {
          return [shapeId, "inherit"];
        }
        return [shapeId, "visible"];
      }

      const stepIndex = orderedSteps.findIndex((step) =>
        step.batches.some((batch) =>
          batch.frames.some((item) => item.shapeId === shapeId),
        ),
      );
      if (stepIndex < 0 || stepIndex > currentStepIndex) {
        return [shapeId, "hidden"];
      }
      const thisBatch = orderedSteps[stepIndex].batches.find((batch) =>
        batch.frames.some((item) => item.shapeId === shapeId),
      );
      const lastBatchIncludingThisTrack = orderedSteps
        .slice(0, currentStepIndex + 1)
        .reverse()
        .flatMap((step) => step.batches)
        .find((batch) => batch.trackId === thisBatch?.trackId);
      if (lastBatchIncludingThisTrack?.frames.at(-1)?.shapeId === shapeId) {
        return [shapeId, "visible"];
      }

      // Hidden by default
      return [shapeId, "hidden"];
    });

    return Object.fromEntries(shapesVisibilities);
  }
}
