/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { atom, createShapeId } from "tldraw";
import type { Editor, TLShapeId } from "tldraw";
import { PageRecordType } from "tldraw";
import type { TLPageId } from "tldraw";
import {
  calculateTotalSteps,
  loadHeadlessEditor,
} from "../headless-editor-utils";
import { PresentationManager } from "../presentation-manager";
import { timelineDocToRuntimeSteps } from "../timeline-model/runtime-steps";
import { transitionProgress } from "./video-transition";
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
import { updateVideoConfig } from "./video-anchor";
import { isPlayerAnchor, readPlacements } from "./player-placement";
import {
  resolveVideoConfig,
  getConfigOwnerCarrier,
  readStampedVideoConfig,
  restoreStampedVideoConfig,
  CONFIG_STAMP_CEILING,
} from "./video-anchor";
import {
  applyPasteRemapToContent,
  canonicalizeContentVideoConfig,
  remapContentVideoKeys,
  alreadyOnPage,
  dropContentAlreadyInDocument,
} from "./remap-video-keys";
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

function anchorCarrierIds(editor: Editor, presentationMode: boolean) {
  return editor
    .getCurrentPageShapes()
    .filter(isYouTubeEmbedShape)
    .filter((carrier) => isPlayerAnchor(editor, carrier, presentationMode))
    .map((carrier) => carrier.id);
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
      manager.attachMediaControlFrame(videoId);
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
      manager.attachMediaControlFrame(videoId);
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
      manager.attachMediaControlFrame(videoId);
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
        zIndex: 2000,
        opacity: 1,
      });

      const [placement] = readPlacements(editor, true);
      expect(placement).toBeDefined();
      // One player, keyed by the video — not two, and not none.
      expect(placement!.videoKey).toBe(videoId);
      expect(anchorCarrierIds(editor, true)).toEqual([laterId]);
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
        zIndex: 2000,
        opacity: 1,
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
      // Standalone, on its own media track: the carrier has no frame
      // yet, so there is no batch for the event to join.
      manager.attachMediaControlFrame(videoId);
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          ...editor.getShape(videoId)?.meta,
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
  it("anchors an immediate step instead of leaving the player adrift", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const toShapeId = createShapeId("destination");
      const transitions = getVideoTransitions(editor);
      // The step hides the destination carrier and reveals it a turn
      // later; with nothing stored in between, neither carrier is
      // visible and the player has no anchor at all.
      transitions.start(videoId, {
        fromShapeId: videoId,
        toShapeId,
        startedAt: Date.now(),
        durationMs: 0,
        easing: "linear",
        zIndex: 2000,
        opacity: 1,
      });
      const stored = transitions.$transitions.get().get(videoId);
      expect(stored?.toShapeId).toBe(toShapeId);
      // Nothing to animate: parked at the destination from the start.
      expect(stored != null && transitionProgress(stored, Date.now())).toBe(1);

      transitions.settle(videoId);
      expect(transitions.$transitions.get().size).toBe(0);
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
        zIndex: 2000,
        opacity: 1,
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
      manager.attachMediaControlFrame(videoId);
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
});

describe("a refused duplicate leaves the original alone", () => {
  it("does not re-key the selected carrier when nothing is created", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
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
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      createDuplicateShapesRemap(editor, () =>
        manager.$getTimelineDoc(),
      ).install();

      // tldraw refuses over the page's shape limit and returns without
      // creating anything — or changing the selection. Reading the
      // selection then would hand this ORIGINAL keyframe a new
      // identity, splitting it off from its own video.
      editor.updateInstanceState({ isReadonly: true });
      editor.select(keyframeId);
      const before = JSON.stringify(editor.getShape(keyframeId));
      editor.duplicateShapes([keyframeId], { x: 0, y: 200 });
      editor.updateInstanceState({ isReadonly: false });

      expect(JSON.stringify(editor.getShape(keyframeId))).toBe(before);
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

describe("a tween outliving its own clock", () => {
  it("holds the player at the destination until the step settles it", () => {
    const [editor, dispose] = loadHeadlessEditor();
    const realRaf = globalThis.requestAnimationFrame;
    const pendingTicks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      pendingTicks.push(callback);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      const transitions = getVideoTransitions(editor);
      const transition = {
        fromShapeId: createShapeId("from"),
        toShapeId: createShapeId("to"),
        startedAt: Date.now() - 1000,
        durationMs: 100,
        easing: "easeInCubic" as const,
        zIndex: 2000,
        opacity: 1,
      };
      transitions.start("video-key", transition);

      // The animation frame that lands after the tween's clock has run
      // out, but before the step reveals the destination carrier.
      pendingTicks.at(-1)?.(0);

      // Still anchored, and parked at the destination.
      expect(transitions.$transitions.get().get("video-key")).toEqual(
        transition,
      );
      expect(transitionProgress(transition, Date.now())).toBe(1);

      // The reveal is what ends it.
      transitions.settle("video-key");
      expect(transitions.$transitions.get().has("video-key")).toBe(false);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
      dispose();
    }
  });
});

describe("cutting and pasting a video whose markers stayed behind", () => {
  it("lays down only what the cut removed", () => {
    // What a cut leaves behind in a shared document: the carrier is
    // gone, its auto-included event marker is not.
    const content = {
      shapes: [
        { id: "shape:video", type: "youtube-embed" },
        { id: "shape:marker", type: "media-control" },
      ],
      bindings: [
        { fromId: "shape:marker", toId: "shape:video", type: "media-control" },
      ],
    };

    const pasted = dropContentAlreadyInDocument(
      content,
      (shape) => shape.id === "shape:marker",
    );

    expect(pasted.shapes.map((shape) => shape.id)).toEqual(["shape:video"]);
    // The binding went with it, rather than pointing at a marker the
    // payload no longer carries.
    expect(pasted.bindings).toEqual([]);
  });

  it("lays down everything when none of it is already here", () => {
    // Both readings of "already here": nothing survived the cut, and a
    // move to another page, whose markers stayed behind on the page
    // the video left and so are not on this one.
    const content = {
      shapes: [
        { id: "shape:video", type: "youtube-embed" },
        { id: "shape:marker", type: "media-control" },
      ],
    };
    expect(dropContentAlreadyInDocument(content, () => false)).toBe(content);
  });
});

describe("deleting a carrier on a page that is not open", () => {
  it("repairs that page rather than the one being looked at", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const otherPageId = PageRecordType.createId("other");
      editor.createPage({ id: otherPageId, name: "Other" });
      editor.setCurrentPage(otherPageId);

      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlFrame(videoId);
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("zzz-keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 900,
        meta: { videoKey: videoId },
      });
      updateVideoConfig(editor, videoId, { videoId: "EDITED" });
      expect(markersOf(editor, videoId)).toHaveLength(1);

      // Look somewhere else, then delete the carrier the edit was
      // stamped on and the one keyframe left holding the video.
      const [firstPage] = editor.getPages();
      editor.setCurrentPage(firstPage.id);
      editor.deleteShapes([videoId]);

      const shapesOnOtherPage = () =>
        [...editor.getPageShapeIds(otherPageId)]
          .map((shapeId) => editor.getShape(shapeId))
          .filter((shape) => shape != null);
      const markersOnOtherPage = () =>
        shapesOnOtherPage().filter(
          (shape) =>
            shape.type === MediaControlShapeType &&
            resolveMediaControlVideoKey(editor, shape.id) === videoId,
        );

      const survivors =
        groupCarriersByVideoKey(shapesOnOtherPage()).get(videoId);
      expect(resolveVideoConfig(survivors ?? [])?.videoId).toBe("EDITED");
      expect(markersOnOtherPage()).toHaveLength(1);

      // And the events go when the video's last carrier does, on that
      // page too.
      editor.deleteShapes([keyframeId]);
      expect(markersOnOtherPage()).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});

describe("one batch deleting carriers on two pages", () => {
  it("repairs each page from its own capture", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      // The same key on two pages: a duplicated page, or an import.
      const sharedKey = "video-key";
      const [firstPage] = editor.getPages();
      const secondPageId = PageRecordType.createId("second");
      editor.createPage({ id: secondPageId, name: "Second" });

      const build = (pageId: TLPageId, suffix: string, videoId: string) => {
        editor.setCurrentPage(pageId);
        const ownerId = createVideo(editor, `owner-${suffix}`);
        const owner = editor.getShape(ownerId);
        if (!isYouTubeEmbedShape(owner)) throw new Error("expected a video");
        editor.updateShape({
          id: ownerId,
          type: owner.type,
          meta: { ...owner.meta, videoKey: sharedKey },
        });
        const survivorId = createShapeId(`zzz-survivor-${suffix}`);
        editor.createShape({
          ...owner,
          id: survivorId,
          x: 900,
          meta: { videoKey: sharedKey },
        });
        updateVideoConfig(editor, sharedKey, { videoId });
        return { ownerId, survivorId };
      };
      const first = build(firstPage.id, "first", "FIRST");
      const second = build(secondPageId, "second", "SECOND");
      // A second edit, so this page's revisions outrank the other's and
      // a repair that mixed the two would actually take.
      updateVideoConfig(editor, sharedKey, { videoId: "SECOND" });

      // One operation, spanning both pages, so the repair sees both
      // pages' captures at once.
      editor.setCurrentPage(firstPage.id);
      editor.deleteShapes([first.ownerId, second.ownerId]);

      const configOn = (pageId: TLPageId) =>
        resolveVideoConfig(
          groupCarriersByVideoKey(
            [...editor.getPageShapeIds(pageId)]
              .map((shapeId) => editor.getShape(shapeId))
              .filter((shape) => shape != null),
          ).get(sharedKey) ?? [],
        )?.videoId;

      expect(configOn(firstPage.id)).toBe("FIRST");
      expect(configOn(secondPageId)).toBe("SECOND");
    } finally {
      dispose();
    }
  });
});

describe("editing a carrier", () => {
  it("moves the poster suppression to wherever the player goes", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const keyframeId = createShapeId("zzz-keyframe");
      editor.createShape({
        ...video,
        id: keyframeId,
        x: 900,
        meta: { videoKey: videoId },
      });

      // While nobody is editing, the video's starting position holds
      // the player.
      expect(anchorCarrierIds(editor, false)).toEqual([videoId]);

      // Double-clicking a carrier brings the player to it, before any
      // pointer input can reach the player.
      editor.setEditingShape(keyframeId);

      expect(anchorCarrierIds(editor, false)).toEqual([keyframeId]);
    } finally {
      dispose();
    }
  });
});

describe("a video's first keyframe in a batch", () => {
  it("sets the starting pose without spending the step's duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      editor.updateShape({
        id: videoId,
        type: "youtube-embed",
        meta: {
          ...editor.getShape(videoId)?.meta,
          frame: frameToMetaJson(
            videoCue({
              trackId: "T-video",
              stepId: "s0",
              action: { type: "shapeAnimation", duration: 5000 },
            }),
          ),
        },
      });
      const manager = PresentationManager.create(
        editor,
        atom("current step index", -1),
      );

      manager.moveTo(0);
      await vi.advanceTimersByTimeAsync(0);

      // Nothing to travel from, so nothing to wait for: the carrier is
      // revealed at once, as it is for every other animated shape whose
      // first keyframe only says where it starts.
      expect(editor.getShape(videoId)?.meta.hiddenDuringAnimation).toBeFalsy();
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("counting a snapshot's steps", () => {
  it("drops an orphaned event the way the runtime does", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlFrame(videoId);
      expect(calculateTotalSteps(editor.getSnapshot())).toBe(
        manager.$getTotalSteps(),
      );

      // A shared document keeps the marker when the video's last
      // carrier goes.
      editor.deleteShapes([videoId]);
      expect(markersOf(editor, videoId)).toHaveLength(1);

      // The Slidev addon allocates its clicks from this count, so a
      // step the presentation does not run is a click that goes
      // nowhere and shifts every later one.
      expect(calculateTotalSteps(editor.getSnapshot())).toBe(
        manager.$getTotalSteps(),
      );
    } finally {
      dispose();
    }
  });
});

describe("pasting from a document forked from this one", () => {
  it("keeps the payload's video, not the one sharing its key here", () => {
    // Both documents descend from one snapshot, so the copied video and
    // a video here carry the same key, and each was edited since.
    const sharedKey = "shape:shared";
    const content = {
      shapes: [
        {
          id: sharedKey,
          type: "youtube-embed",
          props: { videoId: "FROM_THE_SOURCE" },
          meta: { videoKey: sharedKey },
        },
      ],
    };

    const pasted = remapContentVideoKeys(
      content,
      "external-paste",
      () => "minted",
      // This document's answer for that key: a different video.
      () => ({
        videoId: "FROM_HERE",
        url: "",
        start: 0,
        muted: false,
        controls: true,
        altText: "",
      }),
    );

    const video = pasted.shapes[0] as { props: { videoId: string } };
    expect(video.props.videoId).toBe("FROM_THE_SOURCE");
  });
});

describe("what a move counts as already here", () => {
  it("recognizes an event by its frame, not only by its shape id", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlFrame(videoId);
      const [marker] = markersOf(editor, videoId);
      const frame = parseFrameMeta(marker.meta?.frame);
      if (frame.kind !== "v2") throw new Error("expected a v2 frame");

      const isAlreadyHere = alreadyOnPage(editor);

      // Moving a video to another page pastes its marker under a new
      // shape id while keeping the event's frame identity. Moving it
      // back therefore arrives carrying an id this page has never
      // seen, for an event that never left it.
      expect(
        isAlreadyHere({
          id: createShapeId("pasted-elsewhere"),
          meta: { frame: marker.meta?.frame },
        }),
      ).toBe(true);

      // A genuinely new event is not already here.
      expect(
        isAlreadyHere({
          id: createShapeId("unrelated"),
          meta: {
            frame: frameToMetaJson({ ...frame.frame, id: "another-frame" }),
          },
        }),
      ).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("pasting an event without its video", () => {
  const eventContent = (videoKey: string) => ({
    shapes: [
      {
        id: "shape:marker",
        type: "media-control",
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "event-frame",
            type: "cue",
            trackId: "T-media",
            stepId: "s-media",
            stepOrderKey: "a1",
            action: { type: "mediaControl", command: "play", videoKey },
          }),
        },
      },
    ],
  });

  it("drops it when the payload came from another document", () => {
    // Both documents descend from one snapshot, so this key names a
    // video here too — one edited apart from the copied event's.
    const pasted = remapContentVideoKeys(
      eventContent("shape:shared"),
      "external-paste",
      () => "minted",
    );
    expect(pasted.shapes).toEqual([]);
  });

  it("keeps it when the copy is from this document", () => {
    // Copying an event alone here is a request for another event on
    // the video it already names.
    const pasted = remapContentVideoKeys(
      eventContent("shape:shared"),
      "duplicate",
      () => "minted",
    );
    expect(pasted.shapes).toHaveLength(1);
  });
});

describe("a tweening player's place in the stack", () => {
  it("keeps the destination's stacking and opacity while it travels", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const destinationId = createShapeId("destination");
      editor.createShape({
        ...video,
        id: destinationId,
        x: 900,
        meta: { videoKey: videoId },
      });

      // tldraw leaves a hidden shape out of `getRenderingShapes()`, and
      // a step hides both carriers for the length of a tween, so the
      // player's stacking and composed opacity can only come from what
      // was read before the hide.
      getVideoTransitions(editor).start(videoId, {
        fromShapeId: videoId,
        toShapeId: destinationId,
        startedAt: Date.now(),
        durationMs: 1000,
        easing: "linear",
        zIndex: 2317,
        opacity: 0.25,
      });

      const [placement] = readPlacements(editor, true);
      // Not 0, which would put the moving video behind every ordinary
      // shape, whose indices start well above it.
      expect(placement?.zIndex).toBe(2317);
      // And not the carrier's own opacity, which ignores a translucent
      // ancestor.
      expect(placement?.opacity).toBe(0.25);
    } finally {
      dispose();
    }
  });

  it("reads that context from the step, before it hides the carrier", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const destinationId = createShapeId("destination");
      editor.createShape({
        ...video,
        id: destinationId,
        x: 900,
        opacity: 0.5,
        meta: {
          videoKey: videoId,
          frame: frameToMetaJson(
            videoCue({
              trackId: "T-video",
              stepId: "s1",
              stepOrderKey: "a2",
              action: { type: "shapeAnimation", duration: 5000 },
            }),
          ),
        },
      });
      editor.updateShape({
        id: videoId,
        type: "youtube-embed",
        meta: {
          ...video.meta,
          frame: frameToMetaJson(
            videoCue({
              trackId: "T-video",
              stepId: "s0",
              stepOrderKey: "a1",
              action: { type: "shapeAnimation" },
            }),
          ),
        },
      });
      const rendered = editor
        .getRenderingShapes()
        .find((shape) => shape.id === destinationId);

      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.moveTo(1);
      await vi.advanceTimersByTimeAsync(0);

      const transition = getVideoTransitions(editor)
        .$transitions.get()
        .get(videoId);
      expect(transition?.toShapeId).toBe(destinationId);
      expect(transition?.zIndex).toBe(rendered?.index);
      expect(transition?.opacity).toBe(rendered?.opacity);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("a video whose last carrier goes, then comes back", () => {
  it("keeps the settings it had when a stale carrier arrives after", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");
      updateVideoConfig(editor, videoId, { videoId: "EDITED" });

      // The last carrier goes, so there is no survivor to repair.
      editor.deleteShapes([videoId]);
      expect(
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId),
      ).toBeUndefined();

      // A peer that was editing while offline sends its carrier, which
      // predates the edit and holds the settings from before it.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...original,
            id: createShapeId("zzz-from-a-peer"),
            x: 900,
            props: { ...original.props, videoId: "STALE" },
            meta: { videoKey: videoId },
          },
        ]);
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers).toHaveLength(1);
      // Without this the video comes back silently reverted, with
      // nothing left saying it had ever been configured.
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });
});

describe("a stamp forged at the top of the range", () => {
  it("is overwritten by the next edit, which reaches every carrier", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");

      // The largest counter a read accepts, under a session id that
      // wins every tie: the most a peer can claim.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...video,
            id: createShapeId("zzz-forged"),
            x: 900,
            props: { ...video.props, videoId: "FORGED" },
            meta: {
              videoKey: videoId,
              videoConfigRev: {
                videoId: { c: CONFIG_STAMP_CEILING - 1, s: "\uffff" },
              },
            },
          },
        ]);
      });
      const carriersNow = () =>
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(resolveVideoConfig(carriersNow())?.videoId).toBe("FORGED");

      updateVideoConfig(editor, videoId, { videoId: "EDITED" });

      // An edit writes every carrier of the video, the forged one
      // included, so the claim it made is not there to be compared
      // against any more. Only a peer that keeps re-sending the record
      // holds the value, which no client-side rule can prevent and
      // which is what the design's server-issued stamps are for.
      expect(resolveVideoConfig(carriersNow())?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });
});

describe("one key, a video on each of two pages", () => {
  it("keeps each page's settings when one page loses its video", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const sharedKey = "video-key";
      const [pageA] = editor.getPages();
      const pageB = PageRecordType.createId("b");
      editor.createPage({ id: pageB, name: "B" });

      const addCarrier = (pageId: TLPageId, id: string): TLShapeId => {
        editor.setCurrentPage(pageId);
        const shapeId = createVideo(editor, id);
        const shape = editor.getShape(shapeId);
        if (!isYouTubeEmbedShape(shape)) throw new Error("expected a video");
        editor.updateShape({
          id: shapeId,
          type: shape.type,
          meta: { ...shape.meta, videoKey: sharedKey },
        });
        return shapeId;
      };
      const configOn = (pageId: TLPageId) =>
        resolveVideoConfig(
          groupCarriersByVideoKey(
            [...editor.getPageShapeIds(pageId)]
              .map((shapeId) => editor.getShape(shapeId))
              .filter((shape) => shape != null),
          ).get(sharedKey) ?? [],
        )?.videoId;

      addCarrier(pageB, "on-b");
      updateVideoConfig(editor, sharedKey, { videoId: "B-CONFIG" });

      const onA = addCarrier(pageA.id, "on-a");
      // The record as it was before page A was configured, which is
      // what an undo or a peer's stale copy brings back.
      const staleA = editor.getShape(onA);
      if (staleA == null) throw new Error("expected a video");
      // Twice, so page A's revisions outrank page B's.
      updateVideoConfig(editor, sharedKey, { videoId: "A-CONFIG" });
      updateVideoConfig(editor, sharedKey, { videoId: "A-CONFIG" });

      // Page A loses its only carrier, so its settings are held for a
      // carrier of that video to come back to.
      editor.deleteShapes([onA]);

      // A carrier appears on page B. Same key, but a different video:
      // page A's held settings are not its to receive, and must not be
      // spent on it either.
      editor.setCurrentPage(pageB);
      const bCarrier = editor
        .getCurrentPageShapes()
        .filter(isYouTubeEmbedShape)[0];
      editor.createShape({
        ...bCarrier,
        id: createShapeId("also-on-b"),
        x: 900,
      });
      expect(configOn(pageB)).toBe("B-CONFIG");

      // And page A's are still there when its own video returns.
      editor.setCurrentPage(pageA.id);
      editor.createShape({ ...staleA, id: createShapeId("back-on-a") });
      expect(configOn(pageA.id)).toBe("A-CONFIG");
    } finally {
      dispose();
    }
  });
});

describe("resizing a video", () => {
  it("keeps the aspect ratio the embedded player is fixed at", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const before = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(before)) throw new Error("expected a video");
      const ratio = before.props.w / before.props.h;

      // Dragging a corner handle out along one axis only.
      editor.select(videoId);
      editor.resizeShape(videoId, { x: 2, y: 1 });

      const after = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(after)) throw new Error("expected a video");
      expect(after.props.w).toBeGreaterThan(before.props.w);
      // The player is letterboxed inside whatever box it is given, so a
      // shape reshaped away from this grows bars rather than picture.
      expect(after.props.w / after.props.h).toBeCloseTo(ratio, 5);
    } finally {
      dispose();
    }
  });
});

describe("adding an event to a carrier that already moves", () => {
  it("joins that movement's batch, so it runs after it", () => {
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
          ...video.meta,
          frame: frameToMetaJson(
            videoCue({ trackId: "T-video", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });
      const stepsBefore = manager.$getTotalSteps();

      manager.attachMediaControlFrame(videoId);

      // A sub frame of the movement's own batch, not a cue on a track
      // of its own: within a batch frames run in sequence, which is
      // what "after the movement" means, and a step's batches do not.
      const [marker] = markersOf(editor, videoId);
      const parsed = parseFrameMeta(marker?.meta?.frame);
      if (parsed.kind !== "v2" || parsed.frame.type !== "sub") {
        throw new Error("expected a v2 sub frame on the marker");
      }
      expect(parsed.frame.cueFrameId).toBe("frame-s0");
      // It joined a step rather than adding one.
      expect(manager.$getTotalSteps()).toBe(stepsBefore);

      const [step] = manager.$getTimelineDoc().steps;
      const batch = step.batches.find((b) => b.trackId === "T-video");
      expect(batch?.frames.map((f) => f.shapeId)).toEqual([videoId, marker.id]);
      // And the runtime walks a batch in order, so the command is not
      // sent until the movement's own duration has been waited out.
      expect(
        timelineDocToRuntimeSteps(manager.$getTimelineDoc())[0]
          .flatMap((b) => b.data)
          .map((f) => f.action.type),
      ).toEqual(["shapeAnimation", "mediaControl"]);
    } finally {
      dispose();
    }
  });
});

describe("a movement that follows a keyframe carrying an event", () => {
  it("still travels from that keyframe's carrier", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const carrier = (id: string, x: number, step: string, key: string) => {
        const shapeId = createShapeId(id);
        editor.createShape({
          ...video,
          id: shapeId,
          x,
          meta: {
            videoKey: videoId,
            frame: frameToMetaJson(
              videoCue({
                trackId: "T-video",
                stepId: step,
                stepOrderKey: key,
                action: { type: "shapeAnimation", duration: 5000 },
              }),
            ),
          },
        });
        return shapeId;
      };
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          ...video.meta,
          frame: frameToMetaJson(
            videoCue({ trackId: "T-video", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });
      const middle = carrier("middle", 400, "s1", "a2");
      carrier("last", 900, "s2", "a3");

      // The event rides on the middle keyframe, so that batch now ends
      // with a marker rather than with the carrier.
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 1),
      );
      manager.attachMediaControlFrame(middle);

      manager.moveTo(2);
      await vi.advanceTimersByTimeAsync(0);

      // The next movement travels from the video that was there, not
      // from the invisible marker that happened to be last in its
      // batch: a marker is no carrier, so the tween would find no
      // origin and the player would jump instead of moving.
      const transition = getVideoTransitions(editor)
        .$transitions.get()
        .get(videoId);
      expect(transition?.fromShapeId).toBe(middle);

      // And the placement resolves that origin, so the player is
      // somewhere between the two rather than parked on the
      // destination.
      const [placement] = readPlacements(editor, true);
      const x = Number(
        /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)/.exec(
          placement?.transform ?? "",
        )?.[1],
      );
      expect(x).toBeGreaterThanOrEqual(400);
      expect(x).toBeLessThan(900);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("a movement that follows an event inside its own batch", () => {
  it("travels from the carrier the batch started at", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          ...video.meta,
          frame: frameToMetaJson(
            videoCue({ trackId: "T-video", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });

      // What dragging an event onto a later movement leaves: the two
      // merge into one batch, the event's frame becoming its cue and
      // the movement a sub frame after it.
      const markerId = createShapeId("marker");
      editor.createShape({
        id: markerId,
        type: MediaControlShapeType,
        x: 400,
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "frame-event",
            type: "cue",
            trackId: "T-video",
            stepId: "s1",
            stepOrderKey: "a2",
            action: {
              type: "mediaControl",
              command: "play",
              videoKey: videoId,
            },
          }),
        },
      });
      const destination = createShapeId("destination");
      editor.createShape({
        ...video,
        id: destination,
        x: 400,
        meta: {
          videoKey: videoId,
          frame: frameToMetaJson({
            v: 2,
            id: "frame-destination",
            type: "sub",
            cueFrameId: "frame-event",
            orderKey: "a1",
            action: { type: "shapeAnimation", duration: 5000 },
          }),
        },
      });

      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      expect(
        timelineDocToRuntimeSteps(manager.$getTimelineDoc())[1]
          .flatMap((b) => b.data)
          .map((f) => f.action.type),
      ).toEqual(["mediaControl", "shapeAnimation"]);

      manager.moveTo(1);
      await vi.advanceTimersByTimeAsync(0);

      // Running the event first leaves the movement's origin where it
      // was. The marker it ran on is no carrier of the video, so a
      // tween from it would find no origin to travel from.
      const transition = getVideoTransitions(editor)
        .$transitions.get()
        .get(videoId);
      expect(transition?.fromShapeId).toBe(videoId);

      const [placement] = readPlacements(editor, true);
      const x = Number(
        /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)/.exec(
          placement?.transform ?? "",
        )?.[1],
      );
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(400);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("a movement whose track holds only an event in between", () => {
  it("travels from the last carrier the track moved to", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      editor.updateShape({
        id: videoId,
        type: video.type,
        meta: {
          ...video.meta,
          frame: frameToMetaJson(
            videoCue({ trackId: "T-video", stepId: "s0", stepOrderKey: "a1" }),
          ),
        },
      });

      // What dragging an event out of its batch onto a step of its own
      // leaves: a batch of the video's own track that holds no
      // movement, standing between two that do.
      const markerId = createShapeId("marker");
      editor.createShape({
        id: markerId,
        type: MediaControlShapeType,
        meta: {
          frame: frameToMetaJson({
            v: 2,
            id: "frame-event",
            type: "cue",
            trackId: "T-video",
            stepId: "s1",
            stepOrderKey: "a2",
            action: {
              type: "mediaControl",
              command: "play",
              videoKey: videoId,
            },
          }),
        },
      });
      const destination = createShapeId("destination");
      editor.createShape({
        ...video,
        id: destination,
        x: 400,
        meta: {
          videoKey: videoId,
          frame: frameToMetaJson(
            videoCue({
              trackId: "T-video",
              stepId: "s2",
              stepOrderKey: "a3",
              action: { type: "shapeAnimation", duration: 5000 },
            }),
          ),
        },
      });

      const manager = PresentationManager.create(
        editor,
        atom("current step index", 1),
      );
      manager.moveTo(2);
      await vi.advanceTimersByTimeAsync(0);

      // The event-only batch is not where the video is: it holds no
      // position at all, so the movement travels from the carrier the
      // track last moved to, rather than starting at its destination.
      const transition = getVideoTransitions(editor)
        .$transitions.get()
        .get(videoId);
      expect(transition?.fromShapeId).toBe(videoId);

      const [placement] = readPlacements(editor, true);
      const x = Number(
        /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+)/.exec(
          placement?.transform ?? "",
        )?.[1],
      );
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(400);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});

describe("a locked carrier", () => {
  it("still receives the video's configuration and its repair", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");
      const lockedId = createShapeId("zzz-locked");
      editor.createShape({
        ...original,
        id: lockedId,
        x: 900,
        isLocked: true,
        meta: { videoKey: videoId },
      });

      // Configuring the video reaches every carrier of it, locked or
      // not: the lock is about moving a shape on the canvas, not about
      // which records make up one video.
      updateVideoConfig(editor, videoId, { videoId: "EDITED" });
      const locked = editor.getShape(lockedId);
      if (!isYouTubeEmbedShape(locked)) throw new Error("expected a video");
      expect(locked.props.videoId).toBe("EDITED");

      // And the deletion repair reaches it too, so it is not left
      // holding a blank video after the carrier that was configured
      // goes away.
      editor.deleteShapes([videoId]);
      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });

  it("still receives it when the lock is on an ancestor", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");
      const groupedId = createShapeId("zzz-grouped");
      const companionId = createShapeId("zzz-companion");
      editor.createShape({
        ...original,
        id: groupedId,
        x: 900,
        meta: { videoKey: videoId },
      });
      editor.createShape({
        id: companionId,
        type: "geo",
        x: 1200,
        y: 0,
        props: { w: 50, h: 50 },
      });
      // groupShapes silently no-ops in the headless harness; assemble
      // the group the way it does internally.
      const groupId = createShapeId("zzz-group");
      editor.createShape({ id: groupId, type: "group", x: 0, y: 0 });
      editor.reparentShapes([groupedId, companionId], groupId);
      editor.updateShape({ id: groupId, type: "group", isLocked: true });

      updateVideoConfig(editor, videoId, { videoId: "EDITED" });

      const grouped = editor.getShape(groupedId);
      if (!isYouTubeEmbedShape(grouped)) throw new Error("expected a video");
      expect(grouped.props.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });
});

describe("a carrier arriving from a peer", () => {
  it("is stored as sent, not corrected towards this client's view", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      updateVideoConfig(editor, videoId, { videoId: "MINE" });

      const peerId = createShapeId("zzz-peer");
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...video,
            id: peerId,
            x: 900,
            props: { ...video.props, videoId: "THEIRS" },
            meta: { videoKey: videoId },
          },
        ]);
      });

      const peer = editor.getShape(peerId);
      if (!isYouTubeEmbedShape(peer)) throw new Error("expected the peer's");
      expect(peer.props.videoId).toBe("THEIRS");
    } finally {
      dispose();
    }
  });
});

describe("a deleted video's events in a shared document", () => {
  it("stops occupying steps, and comes back with the video", () => {
    // Shared, so the marker records themselves must stay: claiming a
    // carrier was the last one is not this client's call to make.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const manager = PresentationManager.create(
        editor,
        atom("current step index", 0),
      );
      manager.attachMediaControlFrame(videoId);
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const withVideo = manager.$getTotalSteps();
      expect(markersOf(editor, videoId)).toHaveLength(1);

      editor.deleteShapes([videoId]);

      expect(markersOf(editor, videoId)).toHaveLength(1);
      // The event is still on the page and still names its video, but
      // the video is gone, so it is no longer part of the presentation
      // and leaves no empty step behind.
      expect(manager.$getTotalSteps()).toBe(withVideo - 1);

      // A carrier of the same video returning — an undo here, a peer's
      // record in a real room — restores the events with it.
      editor.createShape({ ...video, id: createShapeId("returned") });
      expect(manager.$getTotalSteps()).toBe(withVideo);
    } finally {
      dispose();
    }
  });
});

describe("deleting the carrier that won a property", () => {
  it("keeps the edit when a stale carrier from a peer is all that survives", () => {
    // The document is shared, so nothing here may assume this client is
    // the only writer.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");

      // A peer built a keyframe carrier from the configuration as it
      // stood, then went offline.
      const staleCarrier = {
        ...original,
        id: createShapeId("zzz-peer-keyframe"),
        x: 900,
        meta: { videoKey: videoId },
      };

      // Meanwhile this client edits the video.
      updateVideoConfig(editor, videoId, { videoId: "EDITED" });

      // The peer reconnects and its carrier merges.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([staleCarrier]);
      });

      // Deleting the carrier this client's edit was stamped on.
      editor.deleteShapes([videoId]);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers).toHaveLength(1);
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });

  it("carries the winning session id, not just its counter", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");

      // Two clients edited this property offline from the same
      // counter, reaching the same value under different sessions. The
      // survivor holds the losing one.
      const survivorId = createShapeId("zzz-survivor");
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...original,
            id: survivorId,
            x: 900,
            props: { ...original.props, videoId: "EDITED" },
            meta: {
              videoKey: videoId,
              videoConfigRev: { videoId: { c: 7, s: "aaa" } },
            },
          },
        ]);
        editor.store.put([
          {
            ...editor.getShape(videoId)!,
            props: { ...original.props, videoId: "EDITED" },
            meta: {
              videoKey: videoId,
              videoConfigRev: { videoId: { c: 7, s: "zzz" } },
            },
          },
        ]);
      });

      editor.deleteShapes([videoId]);

      // A third client's record, ordered behind the deleted winner but
      // ahead of the survivor's own session, arrives afterwards.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...original,
            id: createShapeId("zzz-late"),
            x: 1800,
            props: { ...original.props, videoId: "STALE" },
            meta: {
              videoKey: videoId,
              videoConfigRev: { videoId: { c: 7, s: "mmm" } },
            },
          },
        ]);
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });

  it("does not regress a survivor that moved on after the capture", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");
      const survivorId = createShapeId("zzz-survivor");
      editor.createShape({
        ...original,
        id: survivorId,
        x: 900,
        meta: { videoKey: videoId },
      });

      updateVideoConfig(editor, videoId, { videoId: "OLD", start: 5 });
      // What a deletion would have captured before the record went.
      const captured = readStampedVideoConfig(
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
          [],
      );
      if (captured == null) throw new Error("expected a captured config");

      editor.deleteShapes([videoId]);
      updateVideoConfig(editor, videoId, { videoId: "NEWER" });

      // Replaying the capture must not undo what happened after it.
      restoreStampedVideoConfig(
        editor,
        videoId,
        captured,
        editor.getCurrentPageShapes(),
      );

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      const config = resolveVideoConfig(carriers);
      expect(config?.videoId).toBe("NEWER");
      expect(config?.start).toBe(5);
    } finally {
      dispose();
    }
  });

  it("leaves a property the survivor has already moved past", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
      const videoId = createVideo(editor, "video");
      const original = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(original)) throw new Error("expected a video");

      updateVideoConfig(editor, videoId, { videoId: "EDITED", start: 10 });

      const owner = editor.getShape(videoId)!;
      const ownerStamps = (
        owner.meta as { videoConfigRev: Record<string, { c: number }> }
      ).videoConfigRev;

      // A peer's carrier arrives holding a newer `start` than anything
      // this client has seen, and an older `videoId`.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...original,
            id: createShapeId("zzz-peer"),
            x: 900,
            props: { ...original.props, videoId: "OLD", start: 42 },
            meta: {
              videoKey: videoId,
              videoConfigRev: {
                start: { c: ownerStamps.start.c + 1, s: "peer" },
              },
            },
          },
        ]);
      });

      editor.deleteShapes([videoId]);

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      const config = resolveVideoConfig(carriers);
      expect(config?.videoId).toBe("EDITED");
      expect(config?.start).toBe(42);
    } finally {
      dispose();
    }
  });
});

describe("imported revision stamps cannot pin a configuration", () => {
  it("ignores an out-of-range counter, whichever record carries it", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");
      const otherId = createShapeId("zzz-other");
      editor.createShape({
        ...video,
        id: otherId,
        x: 900,
        meta: { videoKey: videoId },
      });

      const owner = editor.getShape(videoId)!;
      const other = editor.getShape(otherId)!;
      // An ordinary edit.
      editor.updateShape({
        id: owner.id,
        type: owner.type,
        props: { videoId: "EDITED" },
        meta: { ...owner.meta, videoConfigRev: { videoId: { c: 2, s: "a" } } },
      });
      // What a hostile or corrupt record can carry: a counter no
      // increment could outrank, with a session id that wins every tie.
      editor.updateShape({
        id: other.id,
        type: other.type,
        props: { videoId: "PINNED" },
        meta: {
          ...other.meta,
          videoConfigRev: {
            videoId: { c: Number.MAX_VALUE, s: "\uffff" },
          },
        },
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });

  it("keeps a local edit authoritative against a carrier at the ceiling", () => {
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: true });
    try {
      const videoId = createVideo(editor, "video");
      const video = editor.getShape(videoId);
      if (!isYouTubeEmbedShape(video)) throw new Error("expected a video");

      updateVideoConfig(editor, videoId, { videoId: "EDITED" });

      // A carrier reaching this client from a peer, holding the largest
      // counter a read could plausibly be asked to accept. It arrives
      // through the remote path, which is what a synced document does
      // and which the create-time lifecycle never sees.
      editor.store.mergeRemoteChanges(() => {
        editor.store.put([
          {
            ...video,
            id: createShapeId("zzz-stale"),
            x: 900,
            props: { ...video.props, videoId: "STALE" },
            meta: {
              videoKey: videoId,
              videoConfigRev: {
                videoId: { c: CONFIG_STAMP_CEILING, s: "\uffff" },
              },
            },
          },
        ]);
      });

      const carriers =
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoId) ??
        [];
      expect(carriers.map((c) => c.props.videoId).sort()).toEqual([
        "EDITED",
        "STALE",
      ]);
      expect(resolveVideoConfig(carriers)?.videoId).toBe("EDITED");
    } finally {
      dispose();
    }
  });

  it("drops the source's revision history when pasting a new identity", () => {
    const content = {
      shapes: [
        {
          id: "shape:src-video",
          type: "youtube-embed",
          props: { videoId: "M7lc1UVf-VE" },
          meta: {
            videoKey: "shape:src-video",
            videoConfigRev: { videoId: { c: 500, s: "zzz" } },
          },
        },
      ],
    };

    const pasted = remapContentVideoKeys(content, "duplicate", () => "minted");

    const video = pasted.shapes[0] as {
      meta: { videoKey: string; videoConfigRev?: unknown };
    };
    expect(video.meta.videoKey).toBe("minted");
    // A new video starts with a clean history, so a local edit outranks
    // whatever the payload claimed.
    expect(video.meta.videoConfigRev).toBeUndefined();
  });
});
