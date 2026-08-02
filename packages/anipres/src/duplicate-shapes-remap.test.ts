/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import type { TLShapeId } from "tldraw";
import { createShapeId } from "tldraw";
import {
  applyStoredStepKeyUpdates,
  createDuplicateShapesRemap,
} from "./duplicate-shapes-remap";
import { loadHeadlessEditor } from "./headless-editor-utils";
import {
  compareOrderKeys,
  deriveTimeline,
  frameToMetaJson,
  parseFrameMeta,
  type CueFrame,
  type Frame,
  type SubFrame,
} from "./timeline-model";

const ACTION = { type: "shapeAnimation" as const };
function cue(
  id: string,
  stepId: string,
  stepOrderKey: string,
  trackId: string,
): CueFrame {
  return {
    v: 2,
    id,
    type: "cue",
    trackId,
    stepId,
    stepOrderKey,
    action: ACTION,
  };
}
function sub(id: string, cueFrameId: string, orderKey: string): SubFrame {
  return { v: 2, id, type: "sub", cueFrameId, orderKey, action: ACTION };
}

// tldraw's Duplicate action (Cmd/Ctrl+D) calls editor.duplicateShapes,
// which creates copies via createShapes and never goes through
// putContentOntoCurrentPage — so it needs its own relationship-preserving
// remap. These tests run the REAL editor path: install the wrapper + the
// capture hook (as Anipres' mount does), duplicate, and inspect the
// copies' stored frames.
function withEditor<T>(
  entries: { key: string; frame: Frame }[],
  run: (ctx: {
    editor: ReturnType<typeof loadHeadlessEditor>[0];
    ids: Record<string, TLShapeId>;
    copiesOf: () => { shapeId: string; frame: Frame }[];
  }) => T,
): T {
  const [editor, dispose] = loadHeadlessEditor();
  try {
    const ids: Record<string, TLShapeId> = {};
    entries.forEach(({ key }, i) => {
      ids[key] = createShapeId(key);
      editor.createShape({ id: ids[key], type: "geo", x: i * 150, y: 0 });
    });
    for (const { key, frame } of entries) {
      const shape = editor.getShape(ids[key])!;
      editor.updateShape({
        id: ids[key],
        type: shape.type,
        meta: { ...shape.meta, frame: frameToMetaJson(frame) },
      });
    }
    const originalIds = new Set(Object.values(ids));

    const remap = createDuplicateShapesRemap(editor, () =>
      deriveTimeline({
        shapes: editor.getCurrentPageShapes().map((shape) => ({
          shapeId: shape.id,
          frameMeta: shape.meta?.frame,
        })),
        pageId: editor.getCurrentPageId(),
      }),
    );
    remap.install();
    // The capture hook Anipres' beforeCreate safety net provides.
    editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
      if (parseFrameMeta(shape.meta?.frame).kind === "v2") {
        remap.capture(shape.id);
      }
      return shape;
    });

    const copiesOf = () =>
      editor
        .getCurrentPageShapes()
        .filter((shape) => !originalIds.has(shape.id))
        .flatMap((shape) => {
          const parsed = parseFrameMeta(shape.meta?.frame);
          return parsed.kind === "v2"
            ? [{ shapeId: shape.id as string, frame: parsed.frame }]
            : [];
        });

    return run({ editor, ids, copiesOf });
  } finally {
    dispose();
  }
}

describe("duplicateShapes relationship-preserving remap", () => {
  it("keeps duplicated cues of one simultaneous step on ONE fresh step", () => {
    withEditor(
      [
        { key: "a", frame: cue("f1", "s1", "a1", "T") },
        { key: "b", frame: cue("f2", "s1", "a1", "U") },
      ],
      ({ editor, ids, copiesOf }) => {
        editor.duplicateShapes([ids.a, ids.b], { x: 40, y: 40 });
        const copies = copiesOf();
        expect(copies).toHaveLength(2);
        const [c1, c2] = copies.map((c) => c.frame as CueFrame);
        // Fresh SHARED step: copies stay simultaneous, off the original.
        expect(c1.stepId).toBe(c2.stepId);
        expect(c1.stepId).not.toBe("s1");
        expect(c1.stepOrderKey).toBe(c2.stepOrderKey);
        // Fresh distinct tracks (severed from the originals').
        expect(c1.trackId).not.toBe(c2.trackId);
        expect([c1.trackId, c2.trackId]).not.toContain("T");
        expect([c1.trackId, c2.trackId]).not.toContain("U");
        // Fresh distinct frame ids.
        expect(c1.id).not.toBe(c2.id);
        expect(["f1", "f2"]).not.toContain(c1.id);
      },
    );
  });

  it("keeps a duplicated track sequence on ONE fresh track", () => {
    withEditor(
      [
        { key: "a", frame: cue("f1", "s1", "a1", "T") },
        { key: "b", frame: cue("f2", "s2", "a2", "T") },
      ],
      ({ editor, ids, copiesOf }) => {
        editor.duplicateShapes([ids.a, ids.b], { x: 40, y: 40 });
        const [c1, c2] = copiesOf().map((c) => c.frame as CueFrame);
        expect(c1.trackId).toBe(c2.trackId); // sequence stays one track
        expect(c1.trackId).not.toBe("T"); // …severed from the original
        expect(c1.stepId).not.toBe(c2.stepId); // distinct steps stay distinct
      },
    );
  });

  it("re-attaches a duplicated sub frame to its duplicated cue", () => {
    withEditor(
      [
        { key: "a", frame: cue("f1", "s1", "a1", "T") },
        { key: "b", frame: sub("f2", "f1", "a0") },
      ],
      ({ editor, ids, copiesOf }) => {
        editor.duplicateShapes([ids.a, ids.b], { x: 40, y: 40 });
        const copies = copiesOf();
        const copiedCue = copies.find((c) => c.frame.type === "cue")!
          .frame as CueFrame;
        const copiedSub = copies.find((c) => c.frame.type === "sub")!
          .frame as SubFrame;
        expect(copiedCue.id).not.toBe("f1");
        expect(copiedSub.cueFrameId).toBe(copiedCue.id);
      },
    );
  });

  it("places the duplicated step directly after its original", () => {
    withEditor(
      [
        { key: "a", frame: cue("f1", "s1", "a1", "T") },
        { key: "b", frame: cue("f2", "s2", "a5", "U") },
      ],
      ({ editor, ids, copiesOf }) => {
        editor.duplicateShapes([ids.a], { x: 40, y: 40 });
        const [copy] = copiesOf().map((c) => c.frame as CueFrame);
        expect(compareOrderKeys("a1", copy.stepOrderKey)).toBeLessThan(0);
        expect(compareOrderKeys(copy.stepOrderKey, "a5")).toBeLessThan(0);
      },
    );
  });
});

describe("applyStoredStepKeyUpdates", () => {
  it("reaches split members displayed under synthetic recovery steps", () => {
    // Both cues store (s1, a1); the second is displayed under a synthetic
    // recovery step. A stored-stepId-keyed write must update BOTH — a
    // walk over the derived doc's batches would miss the split member
    // and fabricate a step-key-divergence.
    const [editor, dispose] = loadHeadlessEditor();
    try {
      const a = createShapeId("a");
      const b = createShapeId("b");
      editor.createShapes([
        { id: a, type: "geo", x: 0, y: 0 },
        { id: b, type: "geo", x: 150, y: 0 },
      ]);
      for (const [id, frame] of [
        [a, cue("f1", "s1", "a1", "T")],
        [b, cue("f2", "s1", "a1", "T")],
      ] as const) {
        const shape = editor.getShape(id)!;
        editor.updateShape({
          id,
          type: shape.type,
          meta: { ...shape.meta, frame: frameToMetaJson(frame) },
        });
      }
      applyStoredStepKeyUpdates(editor, [{ stepId: "s1", key: "a3" }]);
      for (const id of [a, b]) {
        const parsed = parseFrameMeta(editor.getShape(id)!.meta?.frame);
        expect(parsed.kind).toBe("v2");
        if (parsed.kind === "v2" && parsed.frame.type === "cue") {
          expect(parsed.frame.stepOrderKey).toBe("a3");
        }
      }
    } finally {
      dispose();
    }
  });
});
