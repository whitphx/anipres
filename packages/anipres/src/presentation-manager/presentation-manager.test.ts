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
import { updateMediaControlBindingAnchor } from "../shapes/media-control/MediaControlBinding";

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

function getBoundMarkers(editor: Editor, videoId: TLShapeId) {
  return editor
    .getBindingsToShape(videoId, "media-control")
    .map((binding) => editor.getShape(binding.fromId))
    .filter((shape) => shape?.type === "media-control");
}

describe("attachMediaControlCueFrame", () => {
  function withVideoEditor<T>(
    run: (ctx: {
      manager: PresentationManager;
      editor: Editor;
      videoId: TLShapeId;
    }) => T,
  ): T {
    const [editor, dispose] = loadHeadlessEditor();
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
      manager.attachMediaControlCueFrame(videoId);
      manager.attachMediaControlCueFrame(videoId);

      const markerFrames = getBoundMarkers(editor, videoId).map((shape) =>
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

  it("moves the markers along with the video (binding follow)", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlCueFrame(videoId);
      const [marker] = getBoundMarkers(editor, videoId);
      const { x, y } = marker!;

      editor.updateShape({ id: videoId, type: "youtube-embed", x: 50, y: 70 });

      const moved = editor.getShape(marker!.id)!;
      expect(moved.x).toBe(x + 50);
      expect(moved.y).toBe(y + 70);
    });
  });

  it("keeps a re-anchored marker offset across later video moves", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlCueFrame(videoId);
      const [marker] = getBoundMarkers(editor, videoId);

      // The user drags the marker alone (onTranslateEnd re-anchors; the
      // headless test calls the helper the hook delegates to).
      editor.updateShape({ id: marker!.id, type: marker!.type, x: 500, y: 5 });
      updateMediaControlBindingAnchor(editor, marker!.id);

      editor.updateShape({ id: videoId, type: "youtube-embed", x: 30, y: 40 });

      const moved = editor.getShape(marker!.id)!;
      expect(moved.x).toBe(530);
      expect(moved.y).toBe(45);
    });
  });

  it("deletes the markers along with the video (binding cascade)", () => {
    withVideoEditor(({ manager, editor, videoId }) => {
      manager.attachMediaControlCueFrame(videoId);
      manager.attachMediaControlCueFrame(videoId);
      const markerIds = getBoundMarkers(editor, videoId).map((s) => s!.id);
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
      const video = editor.getShape(videoId)!;
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: { ...video.meta, frame: frameToMetaJson(videoCue) },
      });
      manager.attachMediaControlCueFrame(videoId);

      const groups = manager.$getMediaTrackGroups();
      const [marker] = getBoundMarkers(editor, videoId);
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
      action: { type: "mediaControl", command: "play", duration: 3000 },
    };
    const sub: SubFrame = {
      v: 2,
      id: "mc-sub",
      type: "sub",
      cueFrameId: "mc-cue",
      orderKey: "a1",
      action: { type: "mediaControl", command: "pause" },
    };
    const markerCueId = createShapeId("marker-cue");
    const markerSubId = createShapeId("marker-sub");
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
    for (const markerId of [markerCueId, markerSubId]) {
      editor.createBinding({
        type: "media-control",
        fromId: markerId,
        toId: videoId,
      });
    }
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
