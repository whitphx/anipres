/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import { createShapeId, getSnapshot } from "tldraw";
import type { TLStoreSnapshot } from "tldraw";
import { loadHeadlessEditor } from "../../headless-editor-utils";
import { MediaControlShapeType } from "./MediaControlShape";

describe("media-control shape migrations", () => {
  it("adds the target-size props to markers persisted before them", () => {
    const markerId = createShapeId("marker");
    const [editor, dispose] = loadHeadlessEditor();
    let snapshot: TLStoreSnapshot;
    try {
      editor.createShape({ id: markerId, type: MediaControlShapeType });
      snapshot = getSnapshot(editor.store).document;
    } finally {
      dispose();
    }

    // Rewind the snapshot to the pre-w/h shape version: markers written
    // by earlier builds of this feature carry `props: {}`.
    const old = structuredClone(snapshot) as TLStoreSnapshot & {
      schema: { sequences: Record<string, number> };
    };
    const marker = Object.values(old.store).find(
      (record) => "type" in record && record.type === MediaControlShapeType,
    ) as { props: object };
    marker.props = {};
    old.schema.sequences[`com.tldraw.shape.${MediaControlShapeType}`] = 0;

    const [migratedEditor, disposeMigrated] = loadHeadlessEditor({
      snapshot: old,
    });
    try {
      expect(migratedEditor.getShape(markerId)?.props).toEqual({
        w: null,
        h: null,
      });
    } finally {
      disposeMigrated();
    }
  });
});
