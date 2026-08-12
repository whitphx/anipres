import { describe, expect, it } from "vitest";
import { MediaControlShapeType, YouTubeEmbedShapeType } from "anipres/schema";
import { documentSchema } from "./document-schema";

/**
 * Every record type a client can persist must be registered here.
 * Serving a document is all-or-nothing: one unknown type fails the
 * room's store load, and because the failure is on data already saved,
 * a build missing a registration cannot serve documents that a build
 * with it created.
 */
describe("document schema registration", () => {
  it("validates the media records a client persists", () => {
    const video = {
      id: "shape:video",
      typeName: "shape",
      type: YouTubeEmbedShapeType,
      x: 0,
      y: 0,
      rotation: 0,
      index: "a1",
      parentId: "page:page",
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        w: 480,
        h: 270,
        url: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
        videoId: "M7lc1UVf-VE",
        start: 0,
        muted: false,
        controls: true,
        altText: "",
      },
    };
    const marker = {
      id: "shape:marker",
      typeName: "shape",
      type: MediaControlShapeType,
      x: 0,
      y: 0,
      rotation: 0,
      index: "a2",
      parentId: "page:page",
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {},
    };
    for (const record of [video, marker]) {
      expect(() =>
        documentSchema.validateRecord(
          // validateRecord forwards the store only to an
          // `onValidationFailure` handler, which this schema does not
          // configure.
          null as never,
          record as never,
          "createRecord",
          null,
        ),
      ).not.toThrow();
    }
  });

  it("rejects a record type it does not know", () => {
    expect(() =>
      documentSchema.validateRecord(
        null as never,
        {
          id: "shape:x",
          typeName: "shape",
          type: "not-a-registered-type",
          x: 0,
          y: 0,
          rotation: 0,
          index: "a1",
          parentId: "page:page",
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {},
        } as never,
        "createRecord",
        null,
      ),
    ).toThrow();
  });
});
