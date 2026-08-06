import {
  computed,
  createShapeId,
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
  orderKeyBetween,
  parseFrameMeta,
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
import { YouTubeEmbedShapeType } from "../shapes/youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  MEDIA_CONTROL_SHAPE_SIZE,
  resolveMediaControlTarget,
} from "../shapes/media-control/MediaControlShape";
import {
  bindMediaControlMarker,
  MediaControlBindingType,
  type MediaControlBinding,
} from "../shapes/media-control/MediaControlBinding";
import { foldMediaPlaybackStates } from "../media/media-state";
import { YouTubePlayerManager } from "../media/youtube-player-manager";
import { clearHiddenDuringAnimationFlags, runStep } from "./animation";

type ShapeVisibility = NonNullable<
  ReturnType<NonNullable<TldrawBaseProps["getShapeVisibility"]>>
>;

// Functions that depends on `editor` and should be cached by `computed` go here.
export class PresentationManager {
  private constructor(
    public readonly editor: Editor,
    private $currentStepIndex: Atom<number>,
  ) {}

  // A step run's frames execute across timer waits (frame `duration`s),
  // so a run started earlier can wake up after a navigation and fire
  // commands from a step that is no longer active. Each run carries the
  // generation current at its start and bails once a newer one exists.
  private runGeneration = 0;

  // Disposers for the CURRENT run's in-flight effects (temporary
  // animation shapes, history-bail tick listeners, cleanup timers).
  // The generation check only stops FUTURE frames; effects a frame
  // already started must be torn down at the moment of supersession —
  // most urgently the tick listener, whose unguarded history bail would
  // otherwise roll back the successor's (or the user's) changes.
  private activeRunEffectDisposers = new Set<() => void>();

  /**
   * Ties an in-flight effect to the current run. Returns an unregister
   * function for the effect's own normal-completion path.
   */
  registerRunEffect(dispose: () => void): () => void {
    this.activeRunEffectDisposers.add(dispose);
    return () => this.activeRunEffectDisposers.delete(dispose);
  }

  private supersedeActiveRun(): number {
    const generation = ++this.runGeneration;
    const disposers = [...this.activeRunEffectDisposers];
    this.activeRunEffectDisposers.clear();
    for (const dispose of disposers) {
      dispose();
    }
    return generation;
  }

  /**
   * Invalidates the in-flight step run (if any) without starting a new
   * one — e.g. on presentation-mode exit, where pending media commands
   * must not fire over the editor. With no successor run to take over
   * cleanup, the cancelled run's animation-hiding flags are cleared and
   * any camera animation stopped here (a successor run manages the
   * camera itself when it drives it).
   */
  cancelActiveRun(): void {
    this.supersedeActiveRun();
    this.editor.stopCameraAnimation();
    clearHiddenDuringAnimationFlags(this.editor);
  }

  private nextRunGeneration(): number {
    return this.supersedeActiveRun();
  }

  isRunCurrent(generation: number): boolean {
    return generation === this.runGeneration;
  }

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
    const stepOrderKey = orderKeyBetween(lastStepKey, null);

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

  /**
   * Adds a media control event to a video shape: a marker shape bound
   * to the video, carrying a mediaControl cue frame, appended as a new
   * step at the end. All media events of one video share one track (its
   * media track), so the timeline shows them as a sequence and the step
   * machinery keeps them mutually exclusive within a step.
   */
  attachMediaControlCueFrame(videoShapeId: TLShapeId) {
    const video = this.editor.getShape(videoShapeId);
    if (video?.type !== YouTubeEmbedShapeType) {
      return;
    }

    let mediaTrackId: string | null = null;
    let markerCount = 0;
    for (const binding of this.editor.getBindingsToShape<MediaControlBinding>(
      videoShapeId,
      MediaControlBindingType,
    )) {
      const marker = this.editor.getShape(binding.fromId);
      if (marker?.type !== MediaControlShapeType) {
        continue;
      }
      markerCount++;
      const parsed = parseFrameMeta(marker.meta?.frame);
      if (
        parsed.kind === "v2" &&
        parsed.frame.type === "cue" &&
        // Reuse only the MEDIA track: a marker may also carry a
        // shapeAnimation frame on the video's own track (the designed
        // movement-keyframe proxy, see MediaControlShapeProps).
        parsed.frame.action.type === "mediaControl"
      ) {
        mediaTrackId = parsed.frame.trackId;
      }
    }

    const doc = this.$getTimelineDoc();
    const cueFrame: CueFrame = {
      v: 2,
      id: uniqueId(),
      type: "cue",
      trackId: mediaTrackId ?? newTrackId(),
      stepId: uniqueId(),
      stepOrderKey: orderKeyBetween(doc.steps.at(-1)?.orderKey ?? null, null),
      // Always starts as "play" (the most common event); the user picks
      // another command in the frame-edit popover.
      action: { type: "mediaControl", command: "play" },
    };
    const markerId = createShapeId();
    const videoBounds = this.editor.getShapePageBounds(videoShapeId);
    this.editor.run(() => {
      this.editor.createShape({
        id: markerId,
        type: MediaControlShapeType,
        // Below the video, stacked left-to-right in creation order
        // (purely cosmetic; the marker lives on the page and the binding
        // keeps it following the video).
        x: (videoBounds?.x ?? 0) + markerCount * (MEDIA_CONTROL_SHAPE_SIZE + 4),
        y: (videoBounds?.maxY ?? 0) + 8,
        meta: {
          frame: frameToMetaJson(cueFrame),
        },
      });
      bindMediaControlMarker(this.editor, markerId, videoShapeId);
      this.editor.select(markerId);
    });
  }

  /**
   * Track id → bound video shape id, covering every track whose cue
   * frames are carried by a video shape or by markers bound to one. The
   * timeline UI merges these tracks into one row per video (see
   * `calcFrameBatchUIData`): the video's appearance track and its media
   * track are distinct tracks in the data model — a step may legally
   * animate the video and fire a media event at once — but they describe
   * one object, so they read as one row.
   */
  @computed $getMediaTrackGroups(): Record<string, string> {
    const doc = this.$getTimelineDoc();
    const groups: Record<string, string> = {};
    for (const step of doc.steps) {
      for (const batch of step.batches) {
        const carrierId = batch.frames[0]?.shapeId;
        const carrier =
          carrierId != null
            ? this.editor.getShape(carrierId as TLShapeId)
            : null;
        if (carrier == null) {
          continue;
        }
        if (carrier.type === YouTubeEmbedShapeType) {
          groups[batch.trackId] = carrier.id;
        } else if (carrier.type === MediaControlShapeType) {
          const target = resolveMediaControlTarget(this.editor, carrier.id);
          if (target != null) {
            groups[batch.trackId] = target.id;
          }
        }
      }
    }
    return groups;
  }

  @computed $getCurrentPageDescendantShapes(): TLShape[] {
    // tldraw's getCurrentPageShapes() already includes group CHILDREN
    // (it returns every shape whose ancestor chain reaches the page), so
    // the recursion below re-visits them. The result must be deduplicated
    // by shape id — feeding a shape to the derivation twice fabricates a
    // duplicate-frame-id diagnostic and a phantom synthetic step (rule 4
    // then rule 2) for perfectly well-formed grouped content.
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
    const seen = new Set<TLShapeId>();
    const result: TLShape[] = [];
    for (const shape of pageShapes.flatMap(getDescendantShapes)) {
      if (!seen.has(shape.id)) {
        seen.add(shape.id);
        result.push(shape);
      }
    }
    return result;
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

    const prevStepIndex = this.$currentStepIndex.get();
    if (stepIndex === prevStepIndex) {
      return;
    }

    this.$currentStepIndex.set(stepIndex);
    const generation = this.nextRunGeneration();
    if (stepIndex !== prevStepIndex + 1) {
      // Jump or backward move: media events of the skipped/rewound
      // range never fire, so force players to the state the event
      // history up to the PREVIOUS step implies. The target step's own
      // events then fire live in runStep below, same as a normal
      // advance.
      YouTubePlayerManager.get(this.editor).reconcile(
        foldMediaPlaybackStates(
          orderedSteps,
          stepIndex - 1,
          (markerShapeId) =>
            resolveMediaControlTarget(this.editor, markerShapeId)?.id ?? null,
        ),
      );
    }
    runStep(this, orderedSteps, stepIndex, generation);
  }

  public rerunStep(): void {
    const stepIndex = this.$currentStepIndex.get();
    const orderedSteps = this.$getOrderedSteps();
    if (stepIndex < 0 || stepIndex >= orderedSteps.length) {
      return;
    }
    runStep(this, orderedSteps, stepIndex, this.nextRunGeneration());
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

      // Editing chrome, like slides — their frames still drive playback.
      if (shape.type === MediaControlShapeType) {
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

      // A framed video stays visible from its appearance step on. Later
      // batches on its track are marker-carried keyframes, never copies
      // of the video (a copy would mount a second player iframe), so the
      // latest-batch-only rule below must not hide the original.
      if (shape.type === YouTubeEmbedShapeType) {
        return [shapeId, "visible"];
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
