import {
  atom,
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
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import { writeLegacyMediaControlBinding } from "../shapes/media-control/MediaControlBinding";
import { foldMediaPlaybackStates } from "../media/media-state";
import { YouTubePlayerManager } from "../media/youtube-player-manager";
import { getVideoTransitions } from "../media/video-transition";
import { timelineShapesOf } from "../media/live-media-events";
import { clearHiddenDuringAnimationFlags, runStep } from "./animation";

type ShapeVisibility = NonNullable<
  ReturnType<NonNullable<TldrawBaseProps["getShapeVisibility"]>>
>;

function recordsShallowEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  if (a === b) {
    return true;
  }
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => a[key] === b[key])
  );
}

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

  // True from a media-carrying run's start until it settles; see the
  // reconcile branch in _moveTo.
  private runInFlight = false;

  private startRun(
    orderedSteps: RuntimeStep[],
    stepIndex: number,
    generation: number,
  ): void {
    // Only a run with media frames can leave playback diverging from
    // the event history when superseded; flagging a media-free run
    // would make an advance during e.g. a timed camera zoom reconcile,
    // resetting videos the user started by hand.
    this.runInFlight = orderedSteps[stepIndex].some((batch) =>
      batch.data.some((frame) => frame.action.type === "mediaControl"),
    );
    void runStep(this, orderedSteps, stepIndex, generation).finally(() => {
      // A superseded run's promise also settles (its frames bail on the
      // generation check); only the current run's completion counts.
      if (this.isRunCurrent(generation)) {
        this.runInFlight = false;
      }
    });
  }

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
    // No successor run inherits a reconcile obligation; the caller
    // asserts the post-cancel state itself (pauseAll on mode exit). A
    // stale flag would make the next consecutive advance reconcile and
    // restart playback over the editor.
    this.runInFlight = false;
    this.editor.stopCameraAnimation();
    clearHiddenDuringAnimationFlags(this.editor);
    // A cancel reconciles straight to the folded target, so no player
    // is left mid-flight between two carriers.
    getVideoTransitions(this.editor).clear();
  }

  private nextRunGeneration(): number {
    return this.supersedeActiveRun();
  }

  isRunCurrent(generation: number): boolean {
    return generation === this.runGeneration;
  }

  private static instances: WeakMap<Editor, PresentationManager> =
    new WeakMap();
  // Reactive companion to the WeakMap: shape components can render
  // before `handleMount` creates the manager, and a `get` inside a
  // computed that returns undefined without reading any signal would
  // cache that result forever. Reading the epoch gives the computed a
  // parent that `create` invalidates.
  private static $instancesEpoch = atom("PresentationManager epoch", 0);

  static create(
    editor: Editor,
    $currentStepIndex: Atom<number>,
  ): PresentationManager {
    let inst = this.instances.get(editor);
    if (!inst) {
      inst = new PresentationManager(editor, $currentStepIndex);
      this.instances.set(editor, inst);
      this.$instancesEpoch.set(this.$instancesEpoch.get() + 1);
    }
    return inst;
  }

  static get(editor: Editor): PresentationManager | undefined {
    this.$instancesEpoch.get();
    return this.instances.get(editor);
  }

  /** The single derivation everything else consumes. Total: never throws. */
  @computed $getTimelineDoc(): TimelineDoc {
    return deriveTimeline({
      shapes: timelineShapesOf(
        this.editor,
        this.$getCurrentPageDescendantShapes(),
      ).map((shape) => ({
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
    if (!isYouTubeEmbedShape(video)) {
      return;
    }
    const videoKey = getVideoKey(video);

    let mediaTrackId: string | null = null;
    for (const shape of this.editor.getCurrentPageShapes()) {
      if (shape.type !== MediaControlShapeType) {
        continue;
      }
      if (resolveMediaControlVideoKey(this.editor, shape.id) !== videoKey) {
        continue;
      }
      const parsed = parseFrameMeta(shape.meta?.frame);
      if (
        parsed.kind === "v2" &&
        parsed.frame.type === "cue" &&
        // Reuse only the MEDIA track: a video's own animation track
        // belongs to its keyframe carriers, not to its events.
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
      action: { type: "mediaControl", command: "play", videoKey },
    };
    const markerId = createShapeId();
    const videoBounds = this.editor.getShapePageBounds(videoShapeId);
    this.editor.run(() => {
      this.editor.createShape({
        id: markerId,
        type: MediaControlShapeType,
        // Explicit page parent: without it, createShape hit-tests for a
        // receiving parent (a tldraw frame, a focused group) and would
        // rewrite the page coordinates below into that parent's space.
        parentId: this.editor.getCurrentPageId(),
        // Never rendered; parked at the video's origin only so the
        // record's coordinates are not misleading in raw-store reads.
        x: videoBounds?.x ?? 0,
        y: videoBounds?.y ?? 0,
        meta: {
          frame: frameToMetaJson(cueFrame),
        },
      });
      // Compatibility only: an older build resolves an event through
      // this binding and deletes a marker that has none. Nothing in
      // this build reads it.
      writeLegacyMediaControlBinding(this.editor, markerId, videoShapeId);
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
   *
   * Shallow-equal caching keeps the returned identity stable while the
   * grouping is unchanged — the computation reads whole shape records,
   * so without it every shape move would hand the timeline a fresh
   * object and re-derive the UI data on each pointer move.
   */
  @computed({ isEqual: recordsShallowEqual })
  $getMediaTrackGroups(): Record<string, string> {
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
        // Keyed by the VIDEO, not by a carrier: a moved video has one
        // track per keyframe carrier, and grouping by shape id would
        // scatter one logical video across several timeline rows.
        if (isYouTubeEmbedShape(carrier)) {
          groups[batch.trackId] = getVideoKey(carrier);
        } else if (carrier.type === MediaControlShapeType) {
          const videoKey = resolveMediaControlVideoKey(this.editor, carrier.id);
          if (videoKey != null) {
            groups[batch.trackId] = videoKey;
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
    const interruptedRun = this.runInFlight;
    const generation = this.nextRunGeneration();
    if (stepIndex !== prevStepIndex + 1 || interruptedRun) {
      // On a jump or backward move, media events of the skipped/rewound
      // range never fire; on an advance that interrupts an unfinished
      // run, the cancelled run's remaining commands never fire either
      // (e.g. the chained pause of "play, wait, pause"). Both cases
      // force players to the state the event history up to the PREVIOUS
      // step implies. The target step's own events then fire live in
      // runStep below, same as a normal advance. A completed-run
      // consecutive advance deliberately skips this: reconciling resets
      // videos the user started by hand (click-to-interact), which no
      // event history accounts for.
      YouTubePlayerManager.get(this.editor).reconcile(
        foldMediaPlaybackStates(orderedSteps, stepIndex - 1, (markerShapeId) =>
          resolveMediaControlVideoKey(this.editor, markerShapeId),
        ),
      );
    }
    this.startRun(orderedSteps, stepIndex, generation);
  }

  public rerunStep(): void {
    const stepIndex = this.$currentStepIndex.get();
    const orderedSteps = this.$getOrderedSteps();
    if (stepIndex < 0 || stepIndex >= orderedSteps.length) {
      return;
    }
    this.startRun(orderedSteps, stepIndex, this.nextRunGeneration());
  }

  /** The generation of the most recently started run; see isRunCurrent. */
  public currentRunGeneration(): number {
    return this.runGeneration;
  }

  /**
   * Forces players to the state the event history through the CURRENT
   * step implies. Presentation entry: the canvas shows the current
   * step's completed state without replaying its animations, and
   * playback must match — without this, entering at any step (including
   * the initial one, which `moveTo` treats as a no-op move) would leave
   * every player wherever editing left it. Folds through the current
   * step INCLUSIVE, unlike navigation's fold-through-previous, because
   * no run fires the step's events live here.
   */
  public reconcileMediaToCurrentStep(): void {
    // Supersede any run still in flight from edit mode (e.g. a frame
    // edit's rerun); see cancelActiveRun for the flag and cleanup
    // obligations of superseding with no successor run. Unlike there,
    // the camera animation is deliberately left running: a cameraZoom
    // is not a registered run effect, and letting it finish lands the
    // camera on the entered step's target.
    this.supersedeActiveRun();
    this.runInFlight = false;
    clearHiddenDuringAnimationFlags(this.editor);
    getVideoTransitions(this.editor).clear();
    const orderedSteps = this.$getOrderedSteps();
    YouTubePlayerManager.get(this.editor).reconcile(
      foldMediaPlaybackStates(
        orderedSteps,
        this.$currentStepIndex.get(),
        (markerShapeId) =>
          resolveMediaControlVideoKey(this.editor, markerShapeId),
      ),
    );
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
