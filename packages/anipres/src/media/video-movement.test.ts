/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { atom, createShapeId } from "tldraw";
import type { Editor, TLShapeId } from "tldraw";
import { loadHeadlessEditor } from "../headless-editor-utils";
import { PresentationManager } from "../presentation-manager";
import { createDuplicateShapesRemap } from "../duplicate-shapes-remap";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model";
import type { CueFrame } from "../timeline-model";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import {
  getDefaultAnchorCarrier,
  groupCarriersByVideoKey,
} from "./video-anchor";
import { normalizeVideoIdentity } from "./normalize-video-identity";
import { readPlacements } from "./player-placement";
import { resolveVideoConfig, getConfigOwnerCarrier } from "./video-anchor";
import { remapContentVideoKeys } from "./remap-video-keys";
import { getVideoTransitions } from "./video-transition";

function createVideo(
  editor: Editor,
  id: string,
  overrides: { x?: number; y?: number } = {},
): TLShapeId {
  const videoId = createShapeId(id);
  editor.createShape({
    id: videoId,
    type: "youtube-embed",
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    props: {
      url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
      videoId: "M7lc1UVf-VE",
    },
  });
  return videoId;
}

function markersOf(editor: Editor, videoKey: string) {
  return editor
    .getCurrentPageShapes()
    .filter(
      (shape) =>
        shape.type === MediaControlShapeType &&
        resolveMediaControlVideoKey(editor, shape.id) === videoKey,
    );
}

function videoCue(
  overrides: Partial<CueFrame> & { trackId: string },
): CueFrame {
  return {
    v: 2,
    id: `frame-${overrides.stepId ?? overrides.trackId}`,
    type: "cue",
    stepId: "s0",
    stepOrderKey: "a1",
    action: { type: "shapeAnimation" },
    ...overrides,
  } as CueFrame;
}

describe("video identity", () => {
  it("mints a key on the placed video, and a keyframe copy shares it", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      // Materialized, not left to the read-time fallback.
      expect(video.props.videoKey).toBe(videoId);

      // A movement keyframe is an ordinary copy carrying the same key —
      // which is what makes the two shapes one video.
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: undefined,
      });

      const carriers = groupCarriersByVideoKey(editor.getCurrentPageShapes());
      expect(
        carriers
          .get(videoId)
          ?.map((c) => c.id)
          .sort(),
      ).toEqual([videoId, keyframeId].sort());
    } finally {
      dispose();
    }
  });

  it("anchors to the earliest keyframe's carrier", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          frame: frameToMetaJson(
            videoCue({ trackId: "T", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });
      const laterId = createShapeId("later");
      editor.createShape({
        ...video,
        id: laterId,
        x: 400,
        meta: {
          frame: frameToMetaJson(
            videoCue({ trackId: "T", stepId: "s1", stepOrderKey: "a2" }),
          ),
        },
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(getDefaultAnchorCarrier(carriers)?.id).toBe(videoId);
    } finally {
      dispose();
    }
  });

  it("gives a duplicated video its own identity and events", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlCueFrame(videoId);
      expect(markersOf(editor, videoId)).toHaveLength(1);

      createDuplicateShapesRemap(editor, () =>
        manager.$getTimelineDoc(),
      ).install();
      editor.select(videoId);
      editor.duplicateShapes([videoId], { x: 100, y: 0 });

      const videos = editor.getCurrentPageShapes().filter(isYouTubeEmbedShape);
      expect(videos).toHaveLength(2);
      const copy = videos.find((v) => v.id !== videoId)!;
      // Duplicating a video yields an INDEPENDENT video, so its key
      // differs and its copied event follows the copy, not the source.
      expect(getVideoKey(copy)).not.toBe(videoId);
      expect(markersOf(editor, videoId)).toHaveLength(1);
      expect(markersOf(editor, getVideoKey(copy))).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

describe("marker lifecycle without the binding", () => {
  it("keeps a video's events when one keyframe of it is deleted", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlCueFrame(videoId);
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({ ...video, id: keyframeId, x: 400, meta: undefined });

      // The binding's per-shape cascade got exactly this wrong: one
      // keyframe going away is not the video going away.
      editor.deleteShape(keyframeId);
      expect(markersOf(editor, videoId)).toHaveLength(1);

      editor.deleteShape(videoId);
      expect(markersOf(editor, videoId)).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("deletes the events when every carrier goes in one operation", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlCueFrame(videoId);
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({ ...video, id: keyframeId, x: 400, meta: undefined });

      // Checked once after the whole batch: per-shape, each removal
      // would see the other carrier still present and conclude the
      // video survived.
      editor.deleteShapes([videoId, keyframeId]);
      expect(markersOf(editor, videoId)).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});

describe("normalizeVideoIdentity", () => {
  it("rewrites a legacy binding into the event's own target key", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // A pre-videoKey document: the video has no key of its own, and
      // the marker's frame names no target — the binding is the only
      // record of what the event controls.
      const videoId = createShapeId("legacy-video");
      editor.createShape({
        id: videoId,
        type: "youtube-embed",
        x: 0,
        y: 0,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
          videoKey: "",
        },
      });
      const markerId = createShapeId("legacy-marker");
      editor.createShape({
        id: markerId,
        type: "media-control",
        x: 0,
        y: 0,
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "legacy-frame",
            type: "cue",
            trackId: "T-media",
            stepId: "s-media",
            stepOrderKey: "a1",
            action: { type: "mediaControl", command: "play" },
          }),
        },
      });
      editor.createBinding({
        type: "media-control",
        fromId: markerId,
        toId: videoId,
      });

      normalizeVideoIdentity(editor);

      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      expect(video.props.videoKey).toBe(videoId);
      const parsed = parseFrameMeta(editor.getShape(markerId)?.meta?.frame);
      if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
        throw new Error("expected a mediaControl cue frame");
      }
      expect(parsed.frame.action.videoKey).toBe(videoId);
    } finally {
      dispose();
    }
  });

  it("deletes a marker whose target cannot be resolved at all", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const markerId = createShapeId("unbound-marker");
      editor.createShape({
        id: markerId,
        type: "media-control",
        x: 0,
        y: 0,
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "orphan-frame",
            type: "cue",
            trackId: "T-media",
            stepId: "s-media",
            stepOrderKey: "a1",
            action: { type: "mediaControl", command: "play" },
          }),
        },
      });

      normalizeVideoIdentity(editor);

      expect(editor.getShape(markerId)).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("movement keeps one player", () => {
  it("moves the same player across a step instead of unmounting it", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const laterId = createShapeId("later");
      editor.createShape({ ...video, id: laterId, x: 400, meta: undefined });

      // Mid-step, BOTH carriers are hidden — the incoming one
      // explicitly, the outgoing one by no longer being current — so a
      // placement derived from visibility alone would find no anchor,
      // unmount the iframe, and lose the playback position.
      editor.updateShapes([
        {
          id: videoId,
          type: video.type,
          meta: { hiddenDuringAnimation: true },
        },
        {
          id: laterId,
          type: video.type,
          meta: { hiddenDuringAnimation: true },
        },
      ]);
      getVideoTransitions(editor).start(videoId, {
        fromShapeId: videoId,
        toShapeId: laterId,
        startedAt: Date.now(),
        durationMs: 10_000,
        easing: "linear",
      });

      const [placement] = readPlacements(editor, true);
      expect(placement).toBeDefined();
      // One player, keyed by the video — not two, and not none.
      expect(placement!.videoKey).toBe(videoId);
      expect(placement!.anchorShapeId).toBe(laterId);
      // Somewhere between the two carriers, not parked on either.
      const x = Number(
        /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)/.exec(
          placement!.transform,
        )?.[1],
      );
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(400);
    } finally {
      dispose();
    }
  });

  it("drops the tween when a run is cancelled", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      getVideoTransitions(editor).start(videoId, {
        fromShapeId: videoId,
        toShapeId: videoId,
        startedAt: Date.now(),
        durationMs: 10_000,
        easing: "linear",
      });

      manager.cancelActiveRun();

      expect(getVideoTransitions(editor).$transitions.get().size).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe("one video, one configuration", () => {
  it("keeps the player mounted when a keyframe predates the URL", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // A blank video, keyframed before a URL was ever submitted — then
      // the URL lands on the owner.
      const videoId = createShapeId("video");
      editor.createShape({ id: videoId, type: "youtube-embed", x: 0, y: 0 });
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({ ...video, id: keyframeId, x: 400, meta: undefined });
      editor.updateShape({
        id: videoId,
        type: video.type,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      // Both carriers answer with the same video, so reaching the
      // keyframe at a step boundary cannot unmount the live player.
      expect(resolveVideoConfig(carriers)?.videoId).toBe("M7lc1UVf-VE");
      expect(getConfigOwnerCarrier(carriers)?.id).toBe(videoId);
      const placements = readPlacements(editor, false);
      expect(placements).toHaveLength(1);
      expect(placements[0]!.videoId).toBe("M7lc1UVf-VE");
    } finally {
      dispose();
    }
  });

  it("resolves the same config from whichever carrier anchors", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({ ...video, id: keyframeId, x: 400, meta: undefined });
      // A stale keyframe naming a different video must not be able to
      // seat its own answer.
      editor.updateShape({
        id: keyframeId,
        type: video.type,
        props: { videoId: "STALE_ID", url: "" },
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(resolveVideoConfig(carriers)?.videoId).toBe("M7lc1UVf-VE");
    } finally {
      dispose();
    }
  });
});

describe("copy/paste identity", () => {
  it("mints a fresh key for pasted content and retargets its events", () => {
    const content = {
      shapes: [
        {
          id: "shape:src-video",
          type: "youtube-embed",
          props: { videoKey: "shape:src-video", videoId: "M7lc1UVf-VE" },
        },
        {
          id: "shape:src-marker",
          type: "media-control",
          meta: {
            frame: frameToMetaJson({
              v: 2,
              id: "f1",
              type: "cue",
              trackId: "T",
              stepId: "s",
              stepOrderKey: "a1",
              action: {
                type: "mediaControl",
                command: "play",
                videoKey: "shape:src-video",
              },
            }),
          },
        },
      ],
    };

    let n = 0;
    const pasted = remapContentVideoKeys(
      content,
      "duplicate",
      () => `minted-${++n}`,
    );

    const video = pasted.shapes[0] as { props: { videoKey: string } };
    expect(video.props.videoKey).toBe("minted-1");
    const marker = pasted.shapes[1] as { meta: { frame: unknown } };
    const parsed = parseFrameMeta(marker.meta.frame);
    if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
      throw new Error("expected a mediaControl cue frame");
    }
    // The copy's event follows the copy, not the source video.
    expect(parsed.frame.action.videoKey).toBe("minted-1");
  });

  it("keeps the key when the paste is a move", () => {
    const content = {
      shapes: [
        {
          id: "shape:src-video",
          type: "youtube-embed",
          props: { videoKey: "shape:src-video", videoId: "M7lc1UVf-VE" },
        },
      ],
    };
    const moved = remapContentVideoKeys(content, "move", () => "minted");
    const video = moved.shapes[0] as { props: { videoKey: string } };
    // A cut/paste is the same video changing place.
    expect(video.props.videoKey).toBe("shape:src-video");
  });
});

describe("configuration survives owner deletion", () => {
  it("carries the config to the survivor when the owner is deleted", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // The keyframe predates the URL, so its own props are blank —
      // exactly the state that would blank the video if ownership moved
      // without the configuration.
      const videoId = createShapeId("video");
      editor.createShape({ id: videoId, type: "youtube-embed", x: 0, y: 0 });
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({ ...video, id: keyframeId, x: 400, meta: undefined });
      editor.updateShape({
        id: videoId,
        type: video.type,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
      });

      editor.deleteShape(videoId);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers.map((c) => c.id)).toEqual([keyframeId]);
      expect(resolveVideoConfig(carriers)?.videoId).toBe("M7lc1UVf-VE");
      expect(readPlacements(editor, false)).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
