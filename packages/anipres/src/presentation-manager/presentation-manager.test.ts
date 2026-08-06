/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import { atom, createShapeId, getSnapshot, type Editor } from "tldraw";
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

describe("attachMediaControlCueFrame", () => {
  it("mints one media track and reuses it for later events of the same video", () => {
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

      manager.attachMediaControlCueFrame(videoId);
      manager.attachMediaControlCueFrame(videoId);

      const markerFrames = editor
        .getSortedChildIdsForParent(videoId)
        .map((id) => editor.getShape(id))
        .filter((shape) => shape?.type === "media-control")
        .map((shape) => parseFrameMeta(shape?.meta?.frame));
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
    } finally {
      dispose();
    }
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
    editor.createShape({
      id: createShapeId("marker-cue"),
      type: "media-control",
      parentId: videoId,
      x: 0,
      y: 300,
      meta: { frame: frameToMetaJson(cue) },
    });
    editor.createShape({
      id: createShapeId("marker-sub"),
      type: "media-control",
      parentId: videoId,
      x: 40,
      y: 300,
      meta: { frame: frameToMetaJson(sub) },
    });
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
