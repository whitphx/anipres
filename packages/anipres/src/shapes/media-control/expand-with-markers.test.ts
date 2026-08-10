/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { createShapeId } from "tldraw";
import type { Editor, TLShapeId } from "tldraw";
import { loadHeadlessEditor } from "../../headless-editor-utils";
import { createDuplicateShapesRemap } from "../../duplicate-shapes-remap";
import { frameToMetaJson } from "../../timeline-model";
import { resolveMediaControlVideoKey } from "./MediaControlShape";
import { expandShapeIdsWithMediaControlMarkers } from "./expand-with-markers";

function createVideoWithMarker(editor: Editor): {
  videoId: TLShapeId;
  markerId: TLShapeId;
} {
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
  const markerId = createShapeId("marker");
  // A marker names its video in its own frame; the key a placed video
  // mints is its own id.
  editor.createShape({
    id: markerId,
    type: "media-control",
    x: 0,
    y: 0,
    meta: {
      frame: frameToMetaJson({
        v: 2,
        id: "media-frame",
        type: "cue",
        trackId: "T-media",
        stepId: "s-media",
        stepOrderKey: "a1",
        action: { type: "mediaControl", command: "play", videoKey: videoId },
      }),
    },
  });
  return { videoId, markerId };
}

describe("expandShapeIdsWithMediaControlMarkers", () => {
  it("adds a video's bound markers, given ids", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const { videoId, markerId } = createVideoWithMarker(editor);
      const result = expandShapeIdsWithMediaControlMarkers(editor, [videoId]);
      expect(result).toContain(videoId);
      expect(result).toContain(markerId);
    } finally {
      dispose();
    }
  });

  it("adds a video's bound markers, given shape objects", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const { videoId, markerId } = createVideoWithMarker(editor);
      const result = expandShapeIdsWithMediaControlMarkers(editor, [
        editor.getShape(videoId)!,
      ]);
      expect(result).toContain(videoId);
      expect(result).toContain(markerId);
    } finally {
      dispose();
    }
  });

  it("covers a video nested inside an included group without adding descendants", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const { videoId, markerId } = createVideoWithMarker(editor);
      const otherId = createShapeId("other");
      editor.createShape({
        id: otherId,
        type: "geo",
        x: 600,
        y: 0,
        props: { w: 50, h: 50 },
      });
      // groupShapes silently no-ops in the headless test harness;
      // assemble the group the way it does internally.
      const groupId = createShapeId("group");
      editor.createShape({ id: groupId, type: "group", x: 0, y: 0 });
      editor.reparentShapes([videoId, otherId], groupId);
      expect(editor.getSortedChildIdsForParent(groupId)).toHaveLength(2);

      const result = expandShapeIdsWithMediaControlMarkers(editor, [groupId]);
      // Only the marker joins the caller's set: duplicateShapes applies
      // its offset to every explicitly supplied id, so returning the
      // group's children too would displace them twice.
      expect(result.sort()).toEqual([groupId, markerId].sort());

      // Same rule for the marker itself: once swept into the group it
      // is a descendant, and supplying it explicitly would double its
      // offset too.
      editor.reparentShapes([markerId], groupId);
      expect(expandShapeIdsWithMediaControlMarkers(editor, [groupId])).toEqual([
        groupId,
      ]);
    } finally {
      dispose();
    }
  });

  it("preserves child layout and carries markers when duplicating a group with an offset", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const { videoId, markerId } = createVideoWithMarker(editor);
      const otherId = createShapeId("other");
      editor.createShape({
        id: otherId,
        type: "geo",
        x: 600,
        y: 0,
        props: { w: 50, h: 50 },
      });
      const groupId = createShapeId("group");
      editor.createShape({ id: groupId, type: "group", x: 0, y: 0 });
      editor.reparentShapes([videoId, otherId], groupId);
      const originalVideoBounds = editor.getShapePageBounds(videoId)!;
      const originalOtherBounds = editor.getShapePageBounds(otherId)!;

      // The wrapper installed by Anipres performs the expansion, so
      // this exercises the production call chain of tldraw's Duplicate
      // action.
      createDuplicateShapesRemap(editor, () => ({
        version: 1,
        steps: [],
        detachedFrames: [],
        diagnostics: [],
      })).install();
      editor.duplicateShapes([groupId], { x: 100, y: 50 });

      const copies = editor
        .getCurrentPageShapes()
        .filter(
          (shape) =>
            shape.id !== groupId &&
            shape.id !== markerId &&
            !editor.getSortedChildIdsForParent(groupId).includes(shape.id),
        );
      const videoCopy = copies.find((s) => s.type === "youtube-embed")!;
      const otherCopy = copies.find((s) => s.type === "geo")!;
      const markerCopy = copies.find((s) => s.type === "media-control")!;

      // Every child is displaced by the offset exactly once.
      const videoCopyBounds = editor.getShapePageBounds(videoCopy.id)!;
      const otherCopyBounds = editor.getShapePageBounds(otherCopy.id)!;
      expect(videoCopyBounds.x).toBe(originalVideoBounds.x + 100);
      expect(videoCopyBounds.y).toBe(originalVideoBounds.y + 50);
      expect(otherCopyBounds.x).toBe(originalOtherBounds.x + 100);
      expect(otherCopyBounds.y).toBe(originalOtherBounds.y + 50);

      // The marker copy targets the video COPY, which the remap gave a
      // fresh key of its own — a duplicate is an independent video, not
      // another carrier of the source.
      const copyKey = (videoCopy as { meta?: { videoKey?: string } }).meta
        ?.videoKey;
      expect(copyKey).not.toBe(videoId);
      expect(resolveMediaControlVideoKey(editor, markerCopy.id)).toBe(copyKey);
    } finally {
      dispose();
    }
  });

  it("passes a selection with no video through unchanged", () => {
    const [editor, dispose] = loadHeadlessEditor();
    try {
      createVideoWithMarker(editor);
      const rectId = createShapeId("rect");
      editor.createShape({
        id: rectId,
        type: "geo",
        x: 600,
        y: 0,
        props: { w: 50, h: 50 },
      });
      const result = expandShapeIdsWithMediaControlMarkers(editor, [rectId]);
      expect(result).toEqual([rectId]);
    } finally {
      dispose();
    }
  });
});
