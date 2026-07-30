import { describe, it, expect } from "vitest";
import { atom } from "tldraw";
import type { Editor, TLShape } from "tldraw";
import { PresentationManager } from "./presentation-manager";
import { calculateTotalSteps } from "../headless-editor-utils";
import type { TLStoreSnapshot } from "tldraw";

const CUE_FRAME = {
  v: 2,
  id: "f1",
  type: "cue",
  trackId: "t1",
  stepId: "s1",
  stepOrderKey: "a1",
  action: { type: "shapeAnimation" },
};

function makeShape(
  id: string,
  type: string,
  parentId: string,
  meta: Record<string, unknown> = {},
): TLShape {
  return {
    id,
    typeName: "shape",
    type,
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId,
    isLocked: false,
    opacity: 1,
    props: {},
    meta,
  } as unknown as TLShape;
}

// Regression: an animated shape inside a group must be fed to the
// derivation exactly ONCE. tldraw's getCurrentPageShapes() already
// includes group children (every shape whose ancestor chain reaches the
// page), and the group recursion visits them again — without dedup the
// duplicate entry fabricates a duplicate-frame-id diagnostic and a
// phantom synthetic step (rule 4 then rule 2) for well-formed content,
// desyncing live navigation from the snapshot-based step count.
describe("PresentationManager with grouped shapes", () => {
  function makeGroupedEditor() {
    const group = makeShape("shape:g", "group", "page:page");
    const a = makeShape("shape:a", "geo", "shape:g", { frame: CUE_FRAME });
    const b = makeShape("shape:b", "geo", "shape:g");
    const byId = new Map<string, TLShape>(
      [group, a, b].map((shape) => [shape.id, shape]),
    );
    const editor = {
      // tldraw semantics: ALL page descendants, group children INCLUDED.
      getCurrentPageShapes: () => [a, b, group],
      getSortedChildIdsForParent: (id: string) =>
        id === "shape:g" ? ["shape:a", "shape:b"] : [],
      getShape: (id: string) => byId.get(id),
      getCurrentPageId: () => "page:page",
    } as unknown as Editor;
    return PresentationManager.create(editor, atom("stepIndex", 0));
  }

  it("returns each descendant shape exactly once", () => {
    const manager = makeGroupedEditor();
    const ids = manager.$getCurrentPageDescendantShapes().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["shape:a", "shape:b", "shape:g"]);
  });

  it("derives one step and no diagnostics for one grouped animated shape", () => {
    const manager = makeGroupedEditor();
    const doc = manager.$getTimelineDoc();
    expect(doc.steps).toHaveLength(1);
    expect(doc.diagnostics).toEqual([]);
    expect(manager.$getTotalSteps()).toBe(1);
  });

  it("agrees with the snapshot-based step count", () => {
    const manager = makeGroupedEditor();
    const snapshot = {
      store: {
        "document:document": { typeName: "document", id: "document:document" },
        "page:page": {
          typeName: "page",
          id: "page:page",
          name: "Page",
          index: "a1",
        },
        "shape:g": makeShape("shape:g", "group", "page:page"),
        "shape:a": makeShape("shape:a", "geo", "shape:g", {
          frame: CUE_FRAME,
        }),
        "shape:b": makeShape("shape:b", "geo", "shape:g"),
      },
      schema: {},
    } as unknown as TLStoreSnapshot;
    expect(calculateTotalSteps(snapshot)).toBe(manager.$getTotalSteps());
  });
});
