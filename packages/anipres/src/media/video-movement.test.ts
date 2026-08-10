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
  resolveAnchorCarrier,
} from "./video-anchor";
import {
  ensureVideoKeyMaterialized,
  normalizeVideoIdentity,
} from "./normalize-video-identity";
import { updateVideoConfig } from "./video-anchor";
import { getMediaControlBindingTargetId } from "../shapes/media-control/MediaControlBinding";
import { readPlacements } from "./player-placement";
import { resolveVideoConfig, getConfigOwnerCarrier } from "./video-anchor";
import {
  applyPasteRemapToContent,
  canonicalizeContentVideoConfig,
  remapContentVideoKeys,
} from "./remap-video-keys";
import { youTubeEmbedShapeProps } from "../shapes/youtube-embed/YouTubeEmbedShape";
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
      expect(video.meta.videoKey).toBe(videoId);

      // A movement keyframe is an ordinary copy carrying the same key —
      // which is what makes the two shapes one video.
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
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
          videoKey: getVideoKey(video),
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
    // The cascade needs the whole-document view, so it is claimed.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
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
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });

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
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
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
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });

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

      // The event's target is filled in from the binding; the video's
      // own key is not written, because merely opening a document must
      // leave it byte-identical.
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
      editor.createShape({
        ...video,
        id: laterId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });

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
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
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
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
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
          props: { videoId: "M7lc1UVf-VE" },
          meta: { videoKey: "shape:src-video" },
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

    const video = pasted.shapes[0] as { meta: { videoKey: string } };
    expect(video.meta.videoKey).toBe("minted-1");
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
          props: { videoId: "M7lc1UVf-VE" },
          meta: { videoKey: "shape:src-video" },
        },
      ],
    };
    const moved = remapContentVideoKeys(content, "move", () => "minted");
    const video = moved.shapes[0] as { meta?: { videoKey?: string } };
    // A cut/paste is the same video changing place.
    expect(video.meta?.videoKey).toBe("shape:src-video");
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
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
      // The real edit path: a URL edits the VIDEO, so it reaches every
      // carrier of it.
      updateVideoConfig(editor, videoId, {
        url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        videoId: "M7lc1UVf-VE",
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

describe("copies of a stale keyframe carry the real configuration", () => {
  it("duplicating a later keyframe yields a working video", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // The keyframe predates the URL, so its own props are blank while
      // the owner holds the real configuration.
      const videoId = createShapeId("video");
      editor.createShape({ id: videoId, type: "youtube-embed", x: 0, y: 0 });
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
      editor.updateShape({
        id: videoId,
        type: video.type,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
      });

      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      createDuplicateShapesRemap(editor, () =>
        manager.$getTimelineDoc(),
      ).install();
      // Duplicate ONLY the blank keyframe, not the owner.
      editor.select(keyframeId);
      editor.duplicateShapes([keyframeId], { x: 0, y: 200 });

      const copy = editor
        .getCurrentPageShapes()
        .filter(isYouTubeEmbedShape)
        .find((v) => v.id !== videoId && v.id !== keyframeId)!;
      const copyCarriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
          getVideoKey(copy),
        ) ?? [];
      // An independent video, born with the source's real config rather
      // than the blank keyframe's snapshot.
      expect(getVideoKey(copy)).not.toBe(videoId);
      expect(resolveVideoConfig(copyCarriers)?.videoId).toBe("M7lc1UVf-VE");
    } finally {
      dispose();
    }
  });
});

describe("ancestor visibility", () => {
  it("does not place a player under a hidden ancestor", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const siblingId = createShapeId("sibling");
      editor.createShape({
        id: siblingId,
        type: "geo",
        x: 600,
        y: 0,
        props: { w: 50, h: 50 },
      });
      // Two children, so tldraw keeps the group (it discards one with
      // fewer).
      const groupId = createShapeId("group");
      editor.createShape({ id: groupId, type: "group", x: 0, y: 0 });
      editor.reparentShapes([videoId, siblingId], groupId);

      // The carrier itself is not hidden; its container is. A player
      // rendered outside the carrier's DOM does not inherit that.
      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      const anchor = resolveAnchorCarrier(editor, carriers, {
        presentationMode: true,
        visibilities: { [groupId]: "hidden", [videoId]: "visible" },
      });
      expect(anchor).toBeNull();
    } finally {
      dispose();
    }
  });
});

describe("paste applies both remaps in the right order", () => {
  it("keeps the fresh video key after frame remapping rewrites the frame", () => {
    const markerId = "shape:src-marker";
    const content = {
      shapes: [
        {
          id: "shape:src-video",
          type: "youtube-embed",
          props: { videoId: "M7lc1UVf-VE" },
          meta: { videoKey: "shape:src-video" },
        },
        {
          id: markerId,
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
    // What the frame remap produces: a whole frame rebuilt from the
    // ORIGINAL payload, still naming the source video.
    const updatedFrames = new Map([
      [
        markerId,
        {
          v: 2 as const,
          id: "f1-fresh",
          type: "cue" as const,
          trackId: "T-fresh",
          stepId: "s-fresh",
          stepOrderKey: "a2",
          action: {
            type: "mediaControl" as const,
            command: "play" as const,
            videoKey: "shape:src-video",
          },
        },
      ],
    ]);

    const pasted = applyPasteRemapToContent(content, updatedFrames, {
      operation: "duplicate",
      mintKey: () => "minted",
    });

    const video = pasted.shapes[0] as { meta: { videoKey: string } };
    expect(video.meta.videoKey).toBe("minted");
    const marker = pasted.shapes[1] as { meta: { frame: unknown } };
    const parsed = parseFrameMeta(marker.meta.frame);
    if (
      parsed.kind !== "v2" ||
      parsed.frame.type !== "cue" ||
      parsed.frame.action.type !== "mediaControl"
    ) {
      throw new Error("expected a mediaControl cue frame");
    }
    // The remapped frame's identities survive...
    expect(parsed.frame.trackId).toBe("T-fresh");
    // ...and so does the copy's own video key, rather than the source's.
    expect(parsed.frame.action.videoKey).toBe("minted");
  });
});

describe("timeline grouping", () => {
  it("puts a moved video's tracks and its events on one row", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          frame: frameToMetaJson(
            videoCue({ trackId: "T-a", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });
      // A second carrier on its own track — the movement keyframe.
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: {
          videoKey: getVideoKey(video),
          frame: frameToMetaJson(
            videoCue({ trackId: "T-b", stepId: "s1", stepOrderKey: "a2" }),
          ),
        },
      });
      manager.attachMediaControlCueFrame(videoId);

      const groups = manager.$getMediaTrackGroups();
      // One logical video, so every track it owns shares a row.
      expect(groups["T-a"]).toBe(videoId);
      expect(groups["T-b"]).toBe(videoId);
      const mediaTrackIds = Object.keys(groups).filter(
        (trackId) => trackId !== "T-a" && trackId !== "T-b",
      );
      expect(mediaTrackIds).toHaveLength(1);
      expect(groups[mediaTrackIds[0]!]).toBe(videoId);
    } finally {
      dispose();
    }
  });
});

describe("legacy records without the prop", () => {
  it("adds no validated prop, so older builds still load the document", () => {
    // tldraw validates custom shape props and rejects one it does not
    // know, so a `videoKey` prop would make a document that used this
    // feature fail to load wholesale on an earlier release. The key
    // lives in unvalidated `meta` for exactly that reason.
    expect(youTubeEmbedShapeProps).not.toHaveProperty("videoKey");
  });

  it("materializes an absent key when the video is about to be copied", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createShapeId("legacy");
      editor.createShape({
        id: videoId,
        type: "youtube-embed",
        x: 0,
        y: 0,
        props: { videoId: "M7lc1UVf-VE" },
      });
      // Strip the key the minting handler wrote, leaving the record in
      // the shape a pre-change document has.

      // Merely opening a document must leave its records alone: this
      // pass rewrites frames, which live in unvalidated meta, and never
      // reaches for a video's own record.
      const before = JSON.stringify(editor.getShape(videoId));
      normalizeVideoIdentity(editor);
      expect(JSON.stringify(editor.getShape(videoId))).toBe(before);

      // Copying is the first moment the key has to exist, or the copy
      // would fall back to its own id and become a different video.
      ensureVideoKeyMaterialized(editor, [videoId]);

      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      expect(video.meta.videoKey).toBe(videoId);
    } finally {
      dispose();
    }
  });
});

describe("cross-document copy", () => {
  it("carries the video's real config out of the source document", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createShapeId("video");
      editor.createShape({ id: videoId, type: "youtube-embed", x: 0, y: 0 });
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
      editor.updateShape({
        id: videoId,
        type: video.type,
        props: {
          url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
          videoId: "M7lc1UVf-VE",
        },
      });

      // Clipboard content holding only the BLANK later keyframe.
      const keyframe = editor.getShape(keyframeId);
      if (!isYouTubeEmbedShape(keyframe)) throw new Error("expected a video");
      expect(keyframe.props.videoId).toBe("");
      const content = {
        shapes: [
          {
            id: keyframe.id as string,
            type: keyframe.type,
            props: keyframe.props,
            meta: keyframe.meta,
          },
        ],
      };

      const canonical = canonicalizeContentVideoConfig(content, (videoKey) =>
        resolveVideoConfig(
          groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
            videoKey,
          ) ?? [],
        ),
      );

      // The payload leaves with the video's real configuration, so a
      // paste into a document that has never seen the source still
      // yields a working video.
      const copied = canonical.shapes[0] as { props: { videoId: string } };
      expect(copied.props.videoId).toBe("M7lc1UVf-VE");
    } finally {
      dispose();
    }
  });
});

describe("transition hygiene", () => {
  it("stores no transition for an immediate step", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      // Nothing schedules removal for a zero-duration tween, and a
      // stored one outranks presentation visibility — so a later rewind
      // past the video's cue would keep the player up forever.
      getVideoTransitions(editor).start(videoId, {
        fromShapeId: videoId,
        toShapeId: videoId,
        startedAt: Date.now(),
        durationMs: 0,
        easing: "linear",
      });
      expect(getVideoTransitions(editor).$transitions.get().size).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe("normalization covers every page", () => {
  it("rewrites a legacy event's target on a page that is not open", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const otherPageId = editor.getPages()[0]!.id;
      editor.createPage({ name: "second" });
      const secondPageId = editor
        .getPages()
        .find((page) => page.id !== otherPageId)!.id;
      editor.setCurrentPage(secondPageId);
      const videoId = createVideo(editor, "legacy-elsewhere");
      const markerId = createShapeId("legacy-marker-elsewhere");
      editor.createShape({
        id: markerId,
        type: "media-control",
        x: 0,
        y: 0,
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "legacy-frame-elsewhere",
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
      // Back to the first page, so the legacy records are off-screen.
      editor.setCurrentPage(otherPageId);

      normalizeVideoIdentity(editor);

      const parsed = parseFrameMeta(editor.getShape(markerId)?.meta?.frame);
      if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
        throw new Error("expected a mediaControl cue frame");
      }
      expect(parsed.frame.action.videoKey).toBe(videoId);
    } finally {
      dispose();
    }
  });
});

describe("rotation tween", () => {
  it("takes the short way across the angle boundary", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const laterId = createShapeId("later");
      editor.createShape({
        ...video,
        id: laterId,
        meta: { videoKey: getVideoKey(video) },
      });
      // 179° → -179°: two degrees apart, but numerically 358.
      editor.updateShape({
        id: videoId,
        type: video.type,
        rotation: (179 * Math.PI) / 180,
      });
      editor.updateShape({
        id: laterId,
        type: video.type,
        rotation: (-179 * Math.PI) / 180,
      });
      getVideoTransitions(editor).start(videoId, {
        fromShapeId: videoId,
        toShapeId: laterId,
        startedAt: Date.now() - 5_000,
        durationMs: 10_000,
        easing: "linear",
      });

      const [placement] = readPlacements(editor, false);
      expect(placement).toBeDefined();
      // Halfway along the SHORT arc sits just past ±180°, so the
      // matrix's cosine is still near -1. The long way round would be
      // at 0°, with a cosine near +1.
      const cos = Number(
        /matrix\(\s*([-\d.e]+)/.exec(placement!.transform)?.[1],
      );
      expect(cos).toBeLessThan(-0.9);
    } finally {
      dispose();
    }
  });
});

describe("shared documents keep events recoverable", () => {
  it("does not delete markers when this client is not the only writer", () => {
    // The shape a synced document takes: "this was the last carrier" is
    // a claim that cannot be settled locally.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlCueFrame(videoId);
      const markerIds = markersOf(editor, videoId).map((m) => m.id);
      expect(markerIds).toHaveLength(1);

      editor.deleteShape(videoId);
      // Left in place rather than destroyed: an invisible orphan can be
      // cleaned up later, lost events cannot be reconstructed.
      expect(editor.getShape(markerIds[0]!)).toBeDefined();
    } finally {
      dispose();
    }
  });
});

describe("configuration handoff across a batch deletion", () => {
  it("lands on a survivor, not on another shape being deleted", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      // Owner holds the real config; two later keyframes are blank.
      const videoId = createShapeId("video");
      editor.createShape({ id: videoId, type: "youtube-embed", x: 0, y: 0 });
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeA = createShapeId("aaa-keyframe");
      const keyframeB = createShapeId("zzz-keyframe");
      for (const [id, x] of [
        [keyframeA, 400],
        [keyframeB, 800],
      ] as const) {
        editor.createShape({
          ...video,
          id,
          x,
          meta: { videoKey: getVideoKey(video) },
        });
      }
      updateVideoConfig(editor, videoId, {
        url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        videoId: "M7lc1UVf-VE",
      });

      // Delete the owner AND the next carrier by id, in one operation,
      // leaving a third behind.
      editor.deleteShapes([videoId, keyframeA]);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers.map((c) => c.id)).toEqual([keyframeB]);
      // The configuration reached the actual survivor.
      expect(resolveVideoConfig(carriers)?.videoId).toBe("M7lc1UVf-VE");
    } finally {
      dispose();
    }
  });

  it("does not hand off configuration in a shared document", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });

      editor.deleteShape(videoId);

      // No record was rewritten on deletion — a client-authored handoff
      // races collaborators editing the owner or deleting the heir —
      // and the video survives anyway, because the keyframe was born
      // knowing it and reading falls back to any carrier that does.
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

describe("config edits reach every carrier", () => {
  it("keeps a later setting change after the owner is deleted", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });
      // Changed AFTER the keyframe was created, so its birth snapshot
      // is already stale — and in a shared document nothing may write a
      // replacement at deletion time.
      updateVideoConfig(editor, videoId, { start: 42, muted: true });

      editor.deleteShape(videoId);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      const config = resolveVideoConfig(carriers);
      expect(config?.start).toBe(42);
      expect(config?.muted).toBe(true);
    } finally {
      dispose();
    }
  });
});

describe("a follow-up keyframe stays the same video", () => {
  it("keeps the identity when the copy replaces the frame in meta", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");

      // What the timeline's "add after" buttons do: copy the carrier and
      // give the copy the next frame. The identity lives in meta beside
      // that frame, so a copy that replaces meta wholesale would become
      // an independent video — and the player would stop moving between
      // them.
      ensureVideoKeyMaterialized(editor, [videoId]);
      const source = editor.getShape(videoId)!;
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...source,
        id: keyframeId,
        x: 400,
        meta: {
          ...source.meta,
          frame: frameToMetaJson(
            videoCue({ trackId: "T", stepId: "s1", stepOrderKey: "a2" }),
          ),
        },
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers.map((c) => c.id).sort()).toEqual(
        [videoId, keyframeId].sort(),
      );
    } finally {
      dispose();
    }
  });
});

describe("configuration converges under concurrent carriers", () => {
  function setup() {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    const videoId = createVideo(editor, "video");
    const video = editor.getShape(videoId);
    if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
    updateVideoConfig(editor, videoId, {
      url: "https://www.youtube.com/watch?v=NEW",
      videoId: "NEW",
      start: 30,
    });
    return { editor, dispose, videoId, video };
  }

  function configOf(editor: Editor, videoKey: string) {
    return resolveVideoConfig(
      groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoKey) ??
        [],
    );
  }

  it("outranks a stale carrier that arrives after the edit", () => {
    const { editor, dispose, videoId, video } = setup();
    try {
      // How a merge delivers another client's carrier: as an insert,
      // which store side effects see — so it is brought up to date on
      // arrival rather than contradicting the video it joins.
      const staleId = createShapeId("zzz-stale");
      editor.createShape({
        ...video,
        id: staleId,
        x: 900,
        meta: { videoKey: videoId },
        props: { ...video.props, videoId: "OLD", url: "old", start: 0 },
      });

      expect(configOf(editor, videoId)?.videoId).toBe("NEW");

      // And still, once the carriers that were edited are gone: a rule
      // reading structure would promote the newcomer and restore its
      // values.
      editor.deleteShape(videoId);
      expect(configOf(editor, videoId)?.videoId).toBe("NEW");
      expect(configOf(editor, videoId)?.start).toBe(30);
    } finally {
      dispose();
    }
  });

  it("outranks a stale value written onto an existing carrier", () => {
    const { editor, dispose, videoId, video } = setup();
    try {
      const otherId = createShapeId("zzz-other");
      editor.createShape({
        ...video,
        id: otherId,
        x: 900,
        meta: { videoKey: videoId },
      });
      // An unstamped write, which is what an edit that did not go
      // through the config path looks like once merged.
      editor.updateShape({
        id: otherId,
        type: video.type,
        props: { videoId: "OLD" },
      });

      // The stamped edit wins wherever it still lives, so the video
      // does not start answering with the unstamped value.
      expect(configOf(editor, videoId)?.videoId).toBe("NEW");
    } finally {
      dispose();
    }
  });

  it("prefers the newest stamp over the structurally favoured carrier", () => {
    const { editor, dispose, videoId, video } = setup();
    try {
      const otherId = createShapeId("zzz-other");
      editor.createShape({
        ...video,
        id: otherId,
        x: 900,
        meta: { videoKey: videoId },
      });
      const owner = editor.getShape(videoId)!;
      const other = editor.getShape(otherId)!;
      // A merge settles per record, so one carrier can end up holding a
      // newer edit than the carrier structure would favour. Reading the
      // owner would answer with the older value while the document as a
      // whole says otherwise.
      editor.updateShape({
        id: owner.id,
        type: owner.type,
        props: { videoId: "OLDER" },
        meta: { ...owner.meta, videoConfigRev: { videoId: { c: 1, s: "a" } } },
      });
      editor.updateShape({
        id: other.id,
        type: other.type,
        props: { videoId: "NEWER" },
        meta: { ...other.meta, videoConfigRev: { videoId: { c: 2, s: "a" } } },
      });

      expect(configOf(editor, videoId)?.videoId).toBe("NEWER");
    } finally {
      dispose();
    }
  });

  it("breaks an equal-counter tie the same way for every client", () => {
    const { editor, dispose, videoId, video } = setup();
    try {
      const otherId = createShapeId("zzz-other");
      editor.createShape({
        ...video,
        id: otherId,
        x: 900,
        meta: { videoKey: videoId },
      });
      const owner = editor.getShape(videoId)!;
      const other = editor.getShape(otherId)!;
      // Two clients editing from the same counter write the same
      // number; only the session id separates them, and every client
      // separates them identically.
      editor.updateShape({
        id: owner.id,
        type: owner.type,
        props: { videoId: "FROM-A" },
        meta: {
          ...owner.meta,
          videoConfigRev: { videoId: { c: 7, s: "aaa" } },
        },
      });
      editor.updateShape({
        id: other.id,
        type: other.type,
        props: { videoId: "FROM-B" },
        meta: {
          ...other.meta,
          videoConfigRev: { videoId: { c: 7, s: "bbb" } },
        },
      });

      expect(configOf(editor, videoId)?.videoId).toBe("FROM-B");
    } finally {
      dispose();
    }
  });
});

describe("deleting carriers does not rewrite history", () => {
  it("keeps the winning value when every edited carrier is deleted", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      updateVideoConfig(editor, videoId, { videoId: "NEW", start: 30 });

      // Arrives afterwards holding an older account of the video, with
      // no stamps of its own — and is then the ONLY carrier left.
      const staleId = createShapeId("zzz-stale");
      editor.createShape({
        ...video,
        id: staleId,
        x: 900,
        meta: { videoKey: videoId },
      });
      editor.updateShape({
        id: staleId,
        type: video.type,
        props: { videoId: "OLD", start: 0 },
        meta: { videoKey: videoId },
      });

      editor.deleteShape(videoId);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers.map((c) => c.id)).toEqual([staleId]);
      // The survivor was re-stamped while the winning values were still
      // readable, so the deletion did not revert the video.
      const config = resolveVideoConfig(carriers);
      expect(config?.videoId).toBe("NEW");
      expect(config?.start).toBe(30);
    } finally {
      dispose();
    }
  });

  it("keeps an older build able to resolve events after a carrier goes", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlCueFrame(videoId);
      const [marker] = markersOf(editor, videoId);
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 400,
        meta: { videoKey: getVideoKey(video) },
      });

      // tldraw removes a binding with its endpoint, so deleting the
      // bound carrier would leave the marker unbound — which an older
      // build sweeps up as an orphan even though the video survives.
      editor.deleteShape(videoId);

      expect(getMediaControlBindingTargetId(editor, marker!.id)).toBe(
        keyframeId,
      );
    } finally {
      dispose();
    }
  });
});
