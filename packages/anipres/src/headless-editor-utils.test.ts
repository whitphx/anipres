import { describe, it, expect } from "vitest";
import { calculateTotalSteps } from "./headless-editor-utils";
import type { TLEditorSnapshot, TLStoreSnapshot } from "tldraw";

function makeShapeRecord(
  id: string,
  frame: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    id: `shape:${id}`,
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    rotation: 0,
    index: "a1",
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    props: {},
    meta: frame ? { frame } : {},
  };
}

function makeSnapshot(shapes: Record<string, unknown>[]): TLStoreSnapshot {
  const store: Record<string, unknown> = {
    "document:document": { typeName: "document", id: "document:document" },
    "page:page": {
      typeName: "page",
      id: "page:page",
      name: "Page",
      index: "a1",
    },
  };
  for (const shape of shapes) {
    store[shape.id as string] = shape;
  }
  return { store, schema: {} } as unknown as TLStoreSnapshot;
}

function cueFrame(id: string, globalIndex: number, trackId: string) {
  return {
    id,
    type: "cue",
    globalIndex,
    trackId,
    action: { type: "shapeAnimation" },
  };
}

describe("calculateTotalSteps (snapshot JSON, no headless editor)", () => {
  it("returns 0 for a snapshot with no frames", () => {
    const snapshot = makeSnapshot([makeShapeRecord("s1", null)]);
    expect(calculateTotalSteps(snapshot)).toBe(0);
  });

  it("counts distinct globalIndex groups as steps", () => {
    const snapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
      makeShapeRecord("s2", cueFrame("f2", 1, "A")),
      makeShapeRecord("s3", cueFrame("f3", 1, "B")), // simultaneous with f2
    ]);
    expect(calculateTotalSteps(snapshot)).toBe(2);
  });

  it("accepts a TLEditorSnapshot-shaped input ({ document })", () => {
    const storeSnapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
    ]);
    expect(calculateTotalSteps({ document: storeSnapshot })).toBe(1);
  });

  it("chains sub-frames into their cue's batch without affecting the count", () => {
    const snapshot = makeSnapshot([
      makeShapeRecord("s1", cueFrame("f1", 0, "A")),
      makeShapeRecord("s2", {
        id: "f2",
        type: "sub",
        prevFrameId: "f1",
        action: { type: "shapeAnimation" },
      }),
    ]);
    expect(calculateTotalSteps(snapshot)).toBe(1);
  });
});

describe("calculateTotalSteps — page selection", () => {
  function pageRecord(id: string, index: string) {
    return { typeName: "page", id, name: id, index };
  }
  function shapeOn(
    id: string,
    parentId: string,
    frame: Record<string, unknown> | null,
    type = "geo",
  ) {
    return { ...makeShapeRecord(id, frame), id: `shape:${id}`, parentId, type };
  }
  function v2Cue(id: string, stepId: string, key: string, trackId: string) {
    return {
      v: 2,
      id,
      type: "cue",
      trackId,
      stepId,
      stepOrderKey: key,
      action: { type: "shapeAnimation" },
    };
  }
  // page:one has TWO steps; page:two has ONE step.
  function makeTwoPageStore() {
    const store: Record<string, unknown> = {
      "document:document": { typeName: "document", id: "document:document" },
      "page:one": pageRecord("page:one", "a1"),
      "page:two": pageRecord("page:two", "a2"),
    };
    for (const shape of [
      shapeOn("p1a", "page:one", v2Cue("f1", "s1", "a1", "T")),
      shapeOn("p1b", "page:one", v2Cue("f2", "s2", "a2", "U")),
      shapeOn("p2a", "page:two", v2Cue("g1", "s9", "a1", "V")),
    ]) {
      store[shape.id as string] = shape;
    }
    return store;
  }

  it("prefers a valid session.currentPageId (second page selected)", () => {
    const editorSnapshot = {
      document: { store: makeTwoPageStore(), schema: {} },
      session: { currentPageId: "page:two" },
    } as unknown as Partial<TLEditorSnapshot>;
    expect(calculateTotalSteps(editorSnapshot)).toBe(1);
  });

  it("counts the session page's own steps (first page selected)", () => {
    const editorSnapshot = {
      document: { store: makeTwoPageStore(), schema: {} },
      session: { currentPageId: "page:one" },
    } as unknown as Partial<TLEditorSnapshot>;
    expect(calculateTotalSteps(editorSnapshot)).toBe(2);
  });

  it("falls back to the smallest page index for an invalid session page id", () => {
    const editorSnapshot = {
      document: { store: makeTwoPageStore(), schema: {} },
      session: { currentPageId: "page:deleted" },
    } as unknown as Partial<TLEditorSnapshot>;
    // Deterministic fallback: page:one (index a1) — 2 steps.
    expect(calculateTotalSteps(editorSnapshot)).toBe(2);
  });

  it("selects the smallest-index page for a bare multi-page store snapshot", () => {
    // Insert pages in REVERSED object order to prove iteration order
    // plays no role.
    const store = makeTwoPageStore();
    const reversed = Object.fromEntries(Object.entries(store).reverse());
    const snapshot = {
      store: reversed,
      schema: {},
    } as unknown as TLStoreSnapshot;
    expect(calculateTotalSteps(snapshot)).toBe(2);
  });

  it("honors an explicit pageId argument over the session state", () => {
    const editorSnapshot = {
      document: { store: makeTwoPageStore(), schema: {} },
      session: { currentPageId: "page:one" },
    } as unknown as Partial<TLEditorSnapshot>;
    expect(calculateTotalSteps(editorSnapshot, { pageId: "page:two" })).toBe(1);
  });

  it("counts nested group shapes on the selected page and excludes other pages", () => {
    const store: Record<string, unknown> = {
      "document:document": { typeName: "document", id: "document:document" },
      "page:one": pageRecord("page:one", "a1"),
      "page:two": pageRecord("page:two", "a2"),
      // page:one: a group containing an animated shape.
      "shape:g": shapeOn("g", "page:one", null, "group"),
      "shape:child": shapeOn("child", "shape:g", v2Cue("f1", "s1", "a1", "T")),
      // page:two: an animated shape that must NOT leak into the count.
      "shape:other": shapeOn("other", "page:two", v2Cue("g1", "s9", "a1", "V")),
    };
    const snapshot = { store, schema: {} } as unknown as TLStoreSnapshot;
    expect(calculateTotalSteps(snapshot)).toBe(1);
  });

  it("returns zero when the snapshot has no pages", () => {
    const snapshot = {
      store: {
        "document:document": { typeName: "document", id: "document:document" },
      },
      schema: {},
    } as unknown as TLStoreSnapshot;
    expect(calculateTotalSteps(snapshot)).toBe(0);
  });
});
