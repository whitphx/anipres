// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { loadHeadlessEditor } from "anipres";
import { createShapeId } from "tldraw";
import { frameToMetaJson } from "anipres/models";
import { PresentationStatePartUtil } from "./presentation-state.js";

describe("the timeline the agent perceives", () => {
  it("counts the steps the presentation actually runs", () => {
    // A shared document, where deleting a video's last carrier keeps
    // its event markers: claiming the carrier was the last one is not
    // one client's call to make.
    const [editor, dispose] = loadHeadlessEditor({ soleWriter: false });
    try {
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
      editor.createShape({
        id: createShapeId("marker"),
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
            action: {
              type: "mediaControl",
              command: "play",
              videoKey: videoId,
            },
          }),
        },
      });

      const withVideo = PresentationStatePartUtil.getPart({
        editor,
      } as never) as { totalSteps: number };
      expect(withVideo.totalSteps).toBe(1);

      editor.deleteShapes([videoId]);

      // The marker is still on the page and still names its video, but
      // the video is gone, so the event occupies no step. An agent
      // counting it would number every later step differently from the
      // ones the user sees and the presentation plays.
      const part = PresentationStatePartUtil.getPart({ editor } as never) as {
        totalSteps: number;
        steps: unknown[];
      };
      expect(editor.getShape(createShapeId("marker"))).not.toBeUndefined();
      expect(part.totalSteps).toBe(0);
      expect(part.steps).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});
