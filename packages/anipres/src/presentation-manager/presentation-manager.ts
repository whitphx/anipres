import {
  computed,
  uniqueId,
  type Editor,
  type Atom,
  type TLShape,
  type TLShapeId,
  type TldrawBaseProps,
  GroupShapeUtil,
} from "tldraw";
import {
  deriveTimeline,
  frameToMetaJson,
  interactiveKeyAbove,
  type CueFrame,
  type FrameAction,
  type TimelineDoc,
} from "../timeline-model";
import {
  timelineDocToRuntimeSteps,
  type RuntimeStep,
} from "../timeline-model/runtime-steps";
import { newTrackId } from "../models";
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

  /** The single derivation everything else consumes. Total: never throws. */
  @computed $getTimelineDoc(): TimelineDoc {
    const shapes = this.$getCurrentPageDescendantShapes();
    return deriveTimeline({
      shapes: shapes.map((shape) => ({
        shapeId: shape.id,
        frameMeta: shape.meta?.frame,
      })),
      pageId: this.editor.getCurrentPageId(),
    });
  }

  @computed $getOrderedSteps(): RuntimeStep[] {
    return timelineDocToRuntimeSteps(this.$getTimelineDoc());
  }

  @computed $getTotalSteps(): number {
    return this.$getOrderedSteps().length;
  }

  attachCueFrame(shapeId: TLShapeId, frameAction: FrameAction) {
    // One new step appended at the end for this operation; grouped shapes
    // land in the same step (fresh tracks per leaf shape).
    const doc = this.$getTimelineDoc();
    const lastStepKey = doc.steps.at(-1)?.orderKey ?? null;
    const stepId = uniqueId();
    const stepOrderKey = interactiveKeyAbove(lastStepKey);

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
          frame: frameToMetaJson(cueFrame),
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

  /**
   * Resolves a frame id to its carrying shape via the derived doc (the
   * representative shape under duplicate frame ids).
   */
  getShapeByFrameId(frameId: string): TLShape | undefined {
    const doc = this.$getTimelineDoc();
    for (const step of doc.steps) {
      for (const batch of step.batches) {
        for (const frame of batch.frames) {
          if (frame.frameId === frameId) {
            return this.editor.getShape(frame.shapeId as TLShapeId);
          }
        }
      }
    }
    const detached = doc.detachedFrames.find((f) => f.frameId === frameId);
    if (detached != null) {
      return this.editor.getShape(detached.shapeId as TLShapeId);
    }
    return undefined;
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
    const doc = this.$getTimelineDoc();
    const currentStepIndex = this.$currentStepIndex.get();

    // shapeId -> its batch and position within it.
    const frameInfoByShapeId = new Map<
      string,
      { stepIndex: number; trackId: string; isLastFrameOfBatch: boolean }
    >();
    for (const step of orderedSteps) {
      for (const batch of step) {
        batch.data.forEach((frame, frameIndex) => {
          frameInfoByShapeId.set(frame.shapeId, {
            stepIndex: batch.stepIndex,
            trackId: batch.trackId,
            isLastFrameOfBatch: frameIndex === batch.data.length - 1,
          });
        });
      }
    }
    // Detached frames are excluded from playback: hidden.
    const detachedShapeIds = new Set(
      doc.detachedFrames.map((frame) => frame.shapeId),
    );

    // The latest batch per track among the steps played so far — the only
    // batch whose last frame should be visible for that track.
    const latestStepIndexPerTrack = new Map<string, number>();
    for (const step of orderedSteps.slice(0, currentStepIndex + 1)) {
      for (const batch of step) {
        latestStepIndexPerTrack.set(batch.trackId, batch.stepIndex);
      }
    }

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

      if (detachedShapeIds.has(shapeId)) {
        return [shapeId, "hidden"];
      }

      const frameInfo = frameInfoByShapeId.get(shapeId);
      if (frameInfo == null) {
        // No (interpretable) animation frame is attached to this shape,
        // so it should always be visible. Invalid frames fall here too —
        // soft-fail treats them as unframed for playback.
        const parent = editor.getShape(shape.parentId);
        if (parent?.type === GroupShapeUtil.type) {
          return [shapeId, "inherit"];
        }
        return [shapeId, "visible"];
      }

      if (frameInfo.stepIndex > currentStepIndex) {
        return [shapeId, "hidden"];
      }

      // Only the last frame of the track's latest played batch is visible.
      const latestStepIndex = latestStepIndexPerTrack.get(frameInfo.trackId);
      if (
        latestStepIndex === frameInfo.stepIndex &&
        frameInfo.isLastFrameOfBatch
      ) {
        return [shapeId, "visible"];
      }

      return [shapeId, "hidden"];
    });

    return Object.fromEntries(shapesVisibilities);
  }
}
