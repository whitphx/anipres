/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import { atom, createShapeId, getSnapshot, type Editor } from "tldraw";
import { PresentationManager } from "./presentation-manager";
import {
  calculateTotalSteps,
  loadHeadlessEditor,
} from "../headless-editor-utils";
import { frameToMetaJson, type CueFrame } from "../timeline-model";

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
