/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import {
  atom,
  createShapeId,
  getSnapshot,
  type Editor,
  type TLShapeId,
} from "tldraw";
import { PresentationManager } from "./presentation-manager";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { YouTubePlayerManager } from "../media/youtube-player-manager";
import {
  calculateTotalSteps,
  loadHeadlessEditor,
} from "../headless-editor-utils";
import {
  frameToMetaJson,
  parseFrameMeta,
  type CueFrame,
  type SubFrame,
} from "../timeline-model";

const CUE_FRAME: CueFrame = {
  v: 2,
  id: "f1",
  type: "cue",
  trackId: "t1",
  stepId: "s1",
  stepOrderKey: "a1",
  action: { type: "shapeAnimation" },
};

// Regression: an animated shape inside a group must be fed to the
// derivation exactly ONCE. tldraw's getCurrentPageShapes() already
// includes group children (every shape whose ancestor chain reaches the
// page), and the group recursion visits them again — without dedup the
// duplicate entry fabricates a duplicate-frame-id diagnostic and a
// phantom synthetic step (rule 4 then rule 2) for well-formed content,
// desyncing live navigation from the snapshot-based step count.
//
// A REAL editor (not a hand-rolled mock) is load-bearing here: the test
// exists to guard against tldraw's getCurrentPageShapes() semantics, so
// a mock encoding those semantics would keep passing if upstream changed
// them.
describe("PresentationManager with grouped shapes", () => {
  function withGroupedEditor<T>(
    run: (manager: PresentationManager, editor: Editor) => T,
  ): T {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const a = createShapeId("a");
      const b = createShapeId("b");
      const g = createShapeId("g");
      editor.createShapes([
        { id: a, type: "geo", x: 0, y: 0 },
        { id: b, type: "geo", x: 200, y: 0 },
      ]);
      editor.createShape({ id: g, type: "group", x: 0, y: 0 });
      editor.reparentShapes([a, b], g);
      const shapeA = editor.getShape(a)!;
      editor.updateShape({
        id: a,
        type: shapeA.type,
        meta: { ...shapeA.meta, frame: frameToMetaJson(CUE_FRAME) },
      });
      const manager = PresentationManager.create(editor, atom("stepIndex", 0));
      return run(manager, editor);
    } finally {
      dispose();
    }
  }

  it("returns each descendant shape exactly once", () => {
    withGroupedEditor((manager) => {
      const ids = manager.$getCurrentPageDescendantShapes().map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(["shape:a", "shape:b", "shape:g"]);
    });
  });

  it("derives one step and no diagnostics for one grouped animated shape", () => {
    withGroupedEditor((manager) => {
      const doc = manager.$getTimelineDoc();
      expect(doc.steps).toHaveLength(1);
      expect(doc.diagnostics).toEqual([]);
      expect(manager.$getTotalSteps()).toBe(1);
    });
  });

  it("agrees with the snapshot-based step count", () => {
    withGroupedEditor((manager, editor) => {
      const snapshot = getSnapshot(editor.store);
      expect(calculateTotalSteps(snapshot)).toBe(manager.$getTotalSteps());
    });
  });
});

// A video's event markers now name it by `videoKey` in their own
// frames, so they are found by asking each marker what it controls
// rather than by walking a binding.
function getVideoMarkers(editor: Editor, videoId: TLShapeId) {
  const video = editor.getShape(videoId);
  const videoKey = isYouTubeEmbedShape(video) ? getVideoKey(video) : null;
  if (videoKey == null) {
    return [];
  }
  return editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === "media-control" &&
        resolveMediaControlVideoKey(editor, shape.id) === videoKey,
    );
}

describe("attachMediaControlCueFrame", () => {
  function withVideoEditor<T>(
    run: (ctx: {
      manager: PresentationManager;
      editor: Editor;
      videoId: TLShapeId;
    }) => T,
  ): T {
    // These exercise the cleanup that needs a whole-document view.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      const videoId = createShapeId("video");
      editor.createShape({
        id: videoId,
        type: "youtube-embed",
        x: 0,
        y: 0,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
      });
      return run({ manager, editor, videoId });
    } finally {
      dispose();
    }
  }

  it("mints one media track and reuses it for later events of the same video", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlFrame(videoId);
      manager.attachMediaControlFrame(videoId);

      const markerFrames = getVideoMarkers(editor, videoId).map((shape) =>
        parseFrameMeta(shape?.meta?.frame),
      );
      expect(markerFrames).toHaveLength(2);
      const cues = markerFrames.map((parsed) => {
        if (parsed.kind !== "v2" || parsed.frame.type !== "cue") {
          throw new Error("expected a v2 cue frame on each marker");
        }
        return parsed.frame;
      });
      // One shared media track, but separate steps — the events form a
      // sequence, never a simultaneous pair.
      expect(cues[1].trackId).toBe(cues[0].trackId);
      expect(cues[1].stepId).not.toBe(cues[0].stepId);
      expect(cues.every((c) => c.action.type === "mediaControl")).toBe(true);

      const doc = manager.$getTimelineDoc();
      expect(doc.steps).toHaveLength(2);
      expect(doc.diagnostics).toEqual([]);
    });
  });

  it("keeps the marker parked at the video's origin across video moves", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlFrame(videoId);
      const [marker] = getVideoMarkers(editor, videoId);
      expect(marker!.x).toBe(0);
      expect(marker!.y).toBe(0);

      editor.updateShape({ id: videoId, type: "youtube-embed", x: 50, y: 70 });

      // Markers are never rendered, but hidden shapes still count toward
      // page bounds (zoomToFit), so a stale position must not linger.
      const moved = editor.getShape(marker!.id)!;
      expect(moved.x).toBe(50);
      expect(moved.y).toBe(70);
    });
  });

  it("parks a marker positioned away from its video", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      // Away from the origin, so parking at the VIDEO is what the
      // assertion below proves — not a reset to (0, 0).
      editor.updateShape({ id: videoId, type: "youtube-embed", x: 120, y: 90 });
      manager.attachMediaControlFrame(videoId);
      const [marker] = getVideoMarkers(editor, videoId);
      editor.updateShape({
        id: marker!.id,
        type: marker!.type,
        x: 400,
        y: 250,
      });

      const parked = editor.getShape(marker!.id)!;
      expect(parked.x).toBe(120);
      expect(parked.y).toBe(90);
    });
  });

  it("re-parks a marker that was moved on its own", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlFrame(videoId);
      const [marker] = getVideoMarkers(editor, videoId);

      // The strip badge selects the marker, and selection-wide
      // operations (arrow-key nudge, align) do not filter hidden
      // shapes — any such move must snap back.
      editor.updateShape({ id: marker!.id, type: marker!.type, x: 500, y: 5 });

      const parked = editor.getShape(marker!.id)!;
      expect(parked.x).toBe(0);
      expect(parked.y).toBe(0);
    });
  });

  it("deletes the markers when the video loses its last carrier", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlFrame(videoId);
      manager.attachMediaControlFrame(videoId);
      const markerIds = getVideoMarkers(editor, videoId).map((s) => s!.id);
      expect(markerIds).toHaveLength(2);

      editor.deleteShape(videoId);

      for (const markerId of markerIds) {
        expect(editor.getShape(markerId)).toBeUndefined();
      }
      // The markers carried the only frames, so the timeline is empty.
      expect(manager.$getTimelineDoc().steps).toHaveLength(0);
    });
  });

  it("groups the video's own track and its media track for the timeline UI", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      const videoCue: CueFrame = {
        v: 2,
        id: "vf",
        type: "cue",
        trackId: "T-video",
        stepId: "sv",
        stepOrderKey: "a0",
        action: { type: "shapeAnimation" },
      };
      // Standalone, on its own media track: the carrier has no frame
      // yet, so there is no batch for the event to join.
      manager.attachMediaControlFrame(videoId);
      const video = editor.getShape(videoId)!;
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: { ...video.meta, frame: frameToMetaJson(videoCue) },
      });

      const groups = manager.$getMediaTrackGroups();
      const [marker] = getVideoMarkers(editor, videoId);
      const parsed = parseFrameMeta(marker?.meta?.frame);
      if (parsed.kind !== "v2" || parsed.frame.type !== "cue") {
        throw new Error("expected a v2 cue frame on the marker");
      }
      expect(groups["T-video"]).toBe(videoId);
      expect(groups[parsed.frame.trackId]).toBe(videoId);
    });
  });
});

describe("step run cancellation", () => {
  function setupVideoWithPlayThenPause(editor: Editor) {
    const videoId = createShapeId("video");
    editor.createShape({
      id: videoId,
      type: "youtube-embed",
      x: 0,
      y: 0,
      props: {
        url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        videoId: "M7lc1UVf-VE",
      },
    });
    const cue: CueFrame = {
      v: 2,
      id: "mc-cue",
      type: "cue",
      trackId: "T-media",
      stepId: "s1",
      stepOrderKey: "a1",
      // The duration is the wait before the batch's next frame.
      action: {
        type: "mediaControl",
        command: "play",
        duration: 3000,
        videoKey: videoId,
      },
    };
    const sub: SubFrame = {
      v: 2,
      id: "mc-sub",
      type: "sub",
      cueFrameId: "mc-cue",
      orderKey: "a1",
      action: { type: "mediaControl", command: "pause", videoKey: videoId },
    };
    // A second step so tests can advance past the play/pause batch.
    const followUpCue: CueFrame = {
      v: 2,
      id: "mc-cue-2",
      type: "cue",
      trackId: "T-media",
      stepId: "s2",
      stepOrderKey: "a2",
      action: { type: "mediaControl", command: "mute", videoKey: videoId },
    };
    const markerCueId = createShapeId("marker-cue");
    const markerSubId = createShapeId("marker-sub");
    const markerFollowUpId = createShapeId("marker-follow-up");
    editor.createShape({
      id: markerCueId,
      type: "media-control",
      x: 0,
      y: 300,
      meta: { frame: frameToMetaJson(cue) },
    });
    editor.createShape({
      id: markerSubId,
      type: "media-control",
      x: 40,
      y: 300,
      meta: { frame: frameToMetaJson(sub) },
    });
    editor.createShape({
      id: markerFollowUpId,
      type: "media-control",
      x: 80,
      y: 300,
      meta: { frame: frameToMetaJson(followUpCue) },
    });
    return { videoId };
  }

  async function runPlayThenPause(cancelDuringWait: boolean) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      setupVideoWithPlayThenPause(editor);
      const commands = vi.spyOn(YouTubePlayerManager.get(editor), "command");

      manager.moveTo(0);
      expect(commands.mock.calls.map(([, a]) => a.command)).toEqual(["play"]);
      if (cancelDuringWait) {
        manager.cancelActiveRun();
      }
      await vi.advanceTimersByTimeAsync(3000);
      return commands.mock.calls.map(([, action]) => action.command);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  }

  it("fires the batch's chained command when left alone", async () => {
    expect(await runPlayThenPause(false)).toEqual(["play", "pause"]);
  });

  it("does not fire remaining commands after the run is invalidated", async () => {
    expect(await runPlayThenPause(true)).toEqual(["play"]);
  });

  it("reconciles a consecutive advance that interrupts an unfinished run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      const { videoId } = setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const commands = vi.spyOn(playerManager, "command");
      const reconcile = vi.spyOn(playerManager, "reconcile");

      manager.moveTo(0);
      // Advance mid-wait: the chained pause has not fired yet.
      await vi.advanceTimersByTimeAsync(1000);
      manager.moveTo(1);

      // The cancelled pause never fires as a command; reconciliation
      // must force the state the event history through step 0 implies.
      expect(reconcile).toHaveBeenCalledTimes(1);
      const folded = reconcile.mock.calls[0][0];
      expect(folded.get(videoId)?.status).toBe("paused");
      await vi.advanceTimersByTimeAsync(3000);
      expect(commands.mock.calls.map(([, a]) => a.command)).toEqual([
        "play",
        "mute",
      ]);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("does not reconcile a consecutive advance after the run settled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const commands = vi.spyOn(playerManager, "command");
      const reconcile = vi.spyOn(playerManager, "reconcile");

      manager.moveTo(0);
      await vi.runAllTimersAsync();
      manager.moveTo(1);

      // A settled run left playback exactly where the event history
      // says; forcing state here would also reset videos the user
      // started by hand.
      expect(reconcile).not.toHaveBeenCalled();
      expect(commands.mock.calls.map(([, a]) => a.command)).toEqual([
        "play",
        "pause",
        "mute",
      ]);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("reconciles presentation entry through the current step inclusive", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // Index 0 is the component's real initial value: entering
      // presentation mode is not a navigation, so nothing else applies
      // step 0's media state.
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      const { videoId } = setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const reconcile = vi.spyOn(playerManager, "reconcile");

      manager.reconcileMediaToCurrentStep();

      expect(reconcile).toHaveBeenCalledTimes(1);
      // Step 0's whole batch (play, then chained pause) is folded in:
      // the canvas shows the step's completed state, so playback does
      // too.
      expect(reconcile.mock.calls[0][0].get(videoId)?.status).toBe("paused");
    } finally {
      dispose();
    }
  });

  it("reconciles presentation entry at a later selected step", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 1),
      );
      const { videoId } = setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const reconcile = vi.spyOn(playerManager, "reconcile");

      manager.reconcileMediaToCurrentStep();

      const folded = reconcile.mock.calls[0][0].get(videoId);
      expect(folded?.status).toBe("paused");
      expect(folded?.muted).toBe(true);
    } finally {
      dispose();
    }
  });

  it("presentation entry supersedes a run left in flight by edit mode", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const commands = vi.spyOn(playerManager, "command");

      manager.moveTo(0);
      await vi.advanceTimersByTimeAsync(1000);
      manager.reconcileMediaToCurrentStep();
      await vi.advanceTimersByTimeAsync(3000);

      // The interrupted run's chained pause must not fire over the
      // state the entry just asserted.
      expect(commands.mock.calls.map(([, a]) => a.command)).toEqual(["play"]);
      // Superseding with no successor run owns the flag cleanup: the
      // interrupted run's shapes must not stay hidden into the
      // presentation.
      expect(
        editor
          .getCurrentPageShapes()
          .filter((shape) => shape.meta?.hiddenDuringAnimation),
      ).toEqual([]);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("does not reconcile an advance after cancelActiveRun", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      setupVideoWithPlayThenPause(editor);
      const playerManager = YouTubePlayerManager.get(editor);
      const reconcile = vi.spyOn(playerManager, "reconcile");

      manager.moveTo(0);
      await vi.advanceTimersByTimeAsync(1000);
      // Presentation-mode exit: the caller asserts the post-cancel
      // state itself (pauseAll), so the next advance must not force the
      // folded state back over it.
      manager.cancelActiveRun();
      manager.moveTo(1);

      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("shape-animation run cancellation", () => {
  function setupAnimationTrack(editor: Editor) {
    const a = createShapeId("animA");
    const b = createShapeId("animB");
    const cueA: CueFrame = {
      v: 2,
      id: "fa",
      type: "cue",
      trackId: "T-anim",
      stepId: "s1",
      stepOrderKey: "a1",
      action: { type: "shapeAnimation" },
    };
    const cueB: CueFrame = {
      v: 2,
      id: "fb",
      type: "cue",
      trackId: "T-anim",
      stepId: "s2",
      stepOrderKey: "a2",
      action: { type: "shapeAnimation", duration: 3000 },
    };
    editor.createShapes([
      {
        id: a,
        type: "geo",
        x: 0,
        y: 0,
        meta: { frame: frameToMetaJson(cueA) },
      },
      {
        id: b,
        type: "geo",
        x: 300,
        y: 0,
        meta: { frame: frameToMetaJson(cueB) },
      },
    ]);
    return { a, b };
  }

  async function runAnimationTo(
    step1: (ctx: {
      editor: Editor;
      manager: PresentationManager;
      a: ReturnType<typeof createShapeId>;
      baseCount: number;
    }) => Promise<void>,
  ) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );
      const { a } = setupAnimationTrack(editor);
      manager.moveTo(0);
      await vi.advanceTimersByTimeAsync(0);
      const baseCount = editor.getCurrentPageShapes().length;

      // Starts animating a temporary copy from A toward B over 3000ms.
      manager.moveTo(1);
      expect(editor.getCurrentPageShapes().length).toBe(baseCount + 1);

      await step1({ editor, manager, a, baseCount });
    } finally {
      dispose();
      vi.useRealTimers();
    }
  }

  it("disposes the temp shape and history-bail listener on cancellation", async () => {
    await runAnimationTo(async ({ editor, manager, a, baseCount }) => {
      manager.cancelActiveRun();
      expect(editor.getCurrentPageShapes().length).toBe(baseCount);

      // A post-cancel edit must survive: the cancelled run's tick
      // listener would bail history back past it, and its pending
      // timeout must not resurrect anything.
      editor.updateShape({ id: a, type: "geo", x: 999 });
      editor.emit("tick", 16);
      await vi.advanceTimersByTimeAsync(3000);
      expect(editor.getShape(a)?.x).toBe(999);
      expect(editor.getCurrentPageShapes().length).toBe(baseCount);
    });
  });

  it("cleans the temp shape up when the run completes undisturbed", async () => {
    await runAnimationTo(async ({ editor, baseCount }) => {
      await vi.advanceTimersByTimeAsync(3000);
      expect(editor.getCurrentPageShapes().length).toBe(baseCount);
    });
  });
});

describe("video visibility in presentation mode", () => {
  function videoVisibility(options: {
    withSubFrameOnItsBatch: boolean;
    currentStepIndex: number;
  }) {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", options.currentStepIndex),
      );
      const videoId = createShapeId("video");
      editor.createShape({
        id: videoId,
        type: "youtube-embed",
        x: 0,
        y: 0,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "video-cue",
            type: "cue",
            trackId: "T-video",
            stepId: "s1",
            stepOrderKey: "a1",
            action: { type: "shapeAnimation" },
          } satisfies CueFrame),
        },
      });
      // A later step on another track, so the presentation can advance
      // past the video's own step.
      editor.createShape({
        id: createShapeId("other"),
        type: "geo",
        x: 400,
        y: 0,
        props: { w: 50, h: 50 },
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "other-cue",
            type: "cue",
            trackId: "T-other",
            stepId: "s2",
            stepOrderKey: "a2",
            action: { type: "shapeAnimation" },
          } satisfies CueFrame),
        },
      });
      if (options.withSubFrameOnItsBatch) {
        editor.createShape({
          id: createShapeId("sub"),
          type: "geo",
          x: 0,
          y: 200,
          props: { w: 10, h: 10 },
          meta: {
            frame: frameToMetaJson({
              v: 2,
              id: "video-sub",
              type: "sub",
              cueFrameId: "video-cue",
              orderKey: "a1",
              action: { type: "shapeAnimation" },
            } satisfies SubFrame),
          },
        });
      }
      return manager.$getShapeVisibilitiesInPresentationMode()[videoId];
    } finally {
      dispose();
    }
  }

  it("keeps a framed video visible after the presentation advances past its step", () => {
    expect(
      videoVisibility({ withSubFrameOnItsBatch: false, currentStepIndex: 1 }),
    ).toBe("visible");
  });

  it("follows the latest-frame-of-batch rule like any other shape", () => {
    // A video used to be exempt: it was always its batch's cue, and
    // could not be replaced by a copy carrying the later keyframe
    // because a copy meant a second player iframe. Now that the player
    // is runtime-owned, copies are ordinary and so is this rule — a sub
    // frame chained onto the batch hides the cue's carrier.
    expect(
      videoVisibility({ withSubFrameOnItsBatch: true, currentStepIndex: 1 }),
    ).toBe("hidden");
  });
});

describe("what an event leaves on stage", () => {
  function visibilities(options: { eventOnAStepOfItsOwn: boolean }) {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 1),
      );
      const videoId = createShapeId("video");
      editor.createShape({
        id: videoId,
        type: "youtube-embed",
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "video-cue",
            type: "cue",
            trackId: "T-video",
            stepId: "s1",
            stepOrderKey: "a1",
            action: { type: "shapeAnimation" },
          } satisfies CueFrame),
        },
      });
      const markerId = createShapeId("marker");
      const event = { type: "mediaControl", command: "play" } as const;
      editor.createShape({
        id: markerId,
        type: MediaControlShapeType,
        meta: {
          frame: frameToMetaJson(
            options.eventOnAStepOfItsOwn
              ? // Dragged out of the video's batch onto a step of its
                // own, which keeps it on the video's track.
                ({
                  v: 2,
                  id: "event-cue",
                  type: "cue",
                  trackId: "T-video",
                  stepId: "s2",
                  stepOrderKey: "a2",
                  action: { ...event, videoKey: videoId },
                } satisfies CueFrame)
              : ({
                  v: 2,
                  id: "event-sub",
                  type: "sub",
                  cueFrameId: "video-cue",
                  orderKey: "a1",
                  action: { ...event, videoKey: videoId },
                } satisfies SubFrame),
          ),
        },
      });
      return manager.$getShapeVisibilitiesInPresentationMode()[videoId];
    } finally {
      dispose();
    }
  }

  // An event is not a place, so it replaces nothing: the carrier it was
  // attached to stays on stage, and a player anchored to it stays
  // mounted. Hiding it would unmount the very video the event controls.
  it("keeps the carrier of the movement it rides on visible", () => {
    expect(visibilities({ eventOnAStepOfItsOwn: false })).toBe("visible");
  });

  it("keeps the carrier visible from a step of its own too", () => {
    expect(visibilities({ eventOnAStepOfItsOwn: true })).toBe("visible");
  });
});
