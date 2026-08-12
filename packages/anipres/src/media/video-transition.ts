// The tween-time anchor state.
//
// A video keyframe mints no temporary clone (see `runFrames`), so
// something has to carry the video across a step boundary — and it
// cannot be the visibility rule. During an animated step there is no
// visible carrier at all: `runStep` hides the incoming frame's carrier
// for the length of the tween, and the outgoing one has stopped being
// current. A placement derived from what is rendered would therefore
// find no anchor exactly when the player must keep moving, unmount the
// iframe, and remount it at the destination — losing playback position,
// which is the one thing this design exists to preserve.
//
// So the anchor is explicit runtime state, held here, outside the
// document: presentation state must not broadcast to collaborators or
// survive an interrupted presentation.

import { atom, EASINGS, type Atom, type Editor, type TLShapeId } from "tldraw";

export interface VideoTransition {
  /** Where the video is coming from. */
  fromShapeId: TLShapeId;
  /** The carrier the step is moving it to; also the config source. */
  toShapeId: TLShapeId;
  startedAt: number;
  durationMs: number;
  easing: keyof typeof EASINGS;
  /**
   * The destination carrier's rendering context, read before the step
   * hid it.
   *
   * tldraw drops a hidden shape from `getRenderingShapes()` entirely
   * (`getUnorderedRenderingShapes` returns without pushing it), and
   * both carriers are hidden for the length of a tween. Reading the
   * player's stacking and composed opacity from that set mid-flight
   * would therefore find nothing and fall back to a bare `0` and the
   * carrier's own opacity, dropping the moving video behind every
   * ordinary shape — their indices start at `maxShapesPerPage * 2` —
   * and losing whatever a translucent ancestor contributes.
   */
  zIndex: number;
  opacity: number;
}

/**
 * Per-editor tween state, keyed by `videoKey`, plus a clock the
 * placement read subscribes to so the interpolation actually advances.
 */
class VideoTransitionStore {
  readonly $transitions: Atom<ReadonlyMap<string, VideoTransition>> = atom(
    "video transitions",
    new Map<string, VideoTransition>(),
  );
  /** Bumped per animation frame while any transition is running. */
  readonly $clock: Atom<number> = atom("video transition clock", 0);

  private rafId: number | null = null;

  private tick = () => {
    this.rafId = null;
    const now = Date.now();
    this.$clock.set(this.$clock.get() + 1);
    // A transition outlives its own duration: it ends when the step
    // reveals the carrier it was travelling to, not when its clock runs
    // out. The two are near-simultaneous but independently scheduled —
    // an animation frame against a timer — and dropping it first would
    // leave the player with no transition and no visible carrier for
    // however long the gap is, which is a placement of nothing: the
    // iframe would be unmounted and remounted at the destination, at
    // every handoff, losing the playback position the whole design
    // exists to carry. Interpolation clamps at 1, so the player simply
    // waits at the destination. Ticking stops meanwhile, since a
    // settled transition has nothing left to advance.
    const stillMoving = [...this.$transitions.get().values()].some(
      (transition) => now - transition.startedAt < transition.durationMs,
    );
    if (stillMoving) {
      this.schedule();
    }
  };

  private schedule(): void {
    if (this.rafId != null || typeof requestAnimationFrame !== "function") {
      return;
    }
    this.rafId = requestAnimationFrame(this.tick);
  }

  start(videoKey: string, transition: VideoTransition): void {
    // A zero-duration step is stored too, though it animates nothing.
    // The step hides the destination carrier before running the frame
    // and reveals it a turn later, so between those two moments a
    // player with no transition has no anchor at all — neither carrier
    // is visible — and would be unmounted and remounted across a
    // handoff that was supposed to be instant. Interpolation is
    // already complete at zero, so this anchors the player at the
    // destination and waits there to be settled.
    const next = new Map(this.$transitions.get());
    next.set(videoKey, transition);
    this.$transitions.set(next);
    this.schedule();
  }

  /**
   * Ends one video's tween, the step having revealed the carrier it was
   * travelling to. A key with no transition is already settled.
   */
  settle(videoKey: string): void {
    const transitions = this.$transitions.get();
    if (!transitions.has(videoKey)) {
      return;
    }
    const next = new Map(transitions);
    next.delete(videoKey);
    this.$transitions.set(next);
  }

  /**
   * Drops every tween. A cancel, a jump or a backward move reconciles
   * straight to the folded target with no tween — the same rule the
   * playback fold follows, for the same reason.
   */
  clear(): void {
    if (this.$transitions.get().size === 0) {
      return;
    }
    this.$transitions.set(new Map());
    this.$clock.set(this.$clock.get() + 1);
  }

  private static instances = new WeakMap<Editor, VideoTransitionStore>();
  static get(editor: Editor): VideoTransitionStore {
    let store = this.instances.get(editor);
    if (store == null) {
      store = new VideoTransitionStore();
      this.instances.set(editor, store);
    }
    return store;
  }
}

export function getVideoTransitions(editor: Editor): VideoTransitionStore {
  return VideoTransitionStore.get(editor);
}

/**
 * How far a tween has run, 0–1, with its easing applied. Reading the
 * clock is what makes a placement recompute per frame.
 */
export function transitionProgress(
  transition: VideoTransition,
  now: number,
): number {
  if (transition.durationMs <= 0) {
    return 1;
  }
  const linear = Math.min(
    1,
    Math.max(0, (now - transition.startedAt) / transition.durationMs),
  );
  return EASINGS[transition.easing](linear);
}
