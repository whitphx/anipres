import { describe, it, expect } from "vitest";
import { moveFrame } from "./frame-movement";
import { calcFrameBatchUIData } from "./frame-ui-data";
import { deriveTimeline, reconcileEditedSteps } from "../timeline-model";
import type {
  CueFrame,
  EditedStep,
  Frame,
  ReconcileResult,
  SubFrame,
} from "../timeline-model";

// Semantic diagnostics (step-key-divergence, same-track-split,
// duplicate-frame-id) are canonicalized IN MEMORY for playback but must
// never be persisted by an ordinary Timeline edit — persistence is
// reserved for the explicit diagnostic-resolution actions. These tests
// run the full editing flow: derive → UI data → moveFrame → reconcile →
// apply → re-derive.

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

type Entry = { shapeId: string; frame: Frame };

function derive(entries: Entry[]) {
  return deriveTimeline({
    shapes: entries.map(({ shapeId, frame }) => ({
      shapeId,
      frameMeta: frame,
    })),
    pageId: "page:page",
  });
}

/** The Timeline's identity conversion: UI data → EditedStep[] unchanged. */
function toEditedSteps(
  ui: ReturnType<typeof calcFrameBatchUIData>,
): EditedStep[] {
  return ui.steps.map((batches, i) => ({
    ...(ui.stepSources[i] != null ? { source: ui.stepSources[i] } : {}),
    batches: batches.map((batch) => ({
      trackId: batch.trackId,
      frames: batch.data.map((frame) => ({
        shapeId: frame.shapeId,
        frameId: frame.id,
        action: frame.action,
      })),
    })),
  }));
}

function reconcile(entries: Entry[], editedSteps: EditedStep[]) {
  let n = 0;
  return reconcileEditedSteps({
    currentFrames: entries,
    editedSteps,
    mintId: () => `minted-${++n}`,
  });
}

function apply(entries: Entry[], result: ReconcileResult): Entry[] {
  const removed = new Set(result.removedShapeIds);
  const updated = new Map(result.updates.map((u) => [u.shapeId, u.frame]));
  return entries
    .filter((entry) => !removed.has(entry.shapeId))
    .map((entry) => ({
      shapeId: entry.shapeId,
      frame: updated.get(entry.shapeId) ?? entry.frame,
    }));
}

function storedFrame(entries: Entry[], shapeId: string): Frame {
  return entries.find((e) => e.shapeId === shapeId)!.frame;
}

describe("semantic-diagnostic preservation through Timeline edits", () => {
  // Divergent step s1: f1 stores a1 (canonical), f2 stores a9.
  const DIVERGENT: Entry[] = [
    { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
    { shapeId: "shape:b", frame: cue("f2", "s1", "a9", "U") },
    { shapeId: "shape:c", frame: cue("f3", "s2", "a3", "V") },
    { shapeId: "shape:d", frame: cue("f4", "s3", "a5", "W") },
  ];

  it("moving an unrelated step preserves divergent stored keys and the diagnostic", () => {
    const doc = derive(DIVERGENT);
    expect(doc.diagnostics).toContainEqual({
      type: "step-key-divergence",
      stepId: "s1",
      shapeIds: ["shape:a", "shape:b"],
    });
    const ui = calcFrameBatchUIData(doc);
    // Move the UNRELATED step s3 (track W, step index 2) to the front.
    const edited = moveFrame(ui.steps, ui.stepSources, "W", 2, 0, -1, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(DIVERGENT, edited!);
    // Only the moved shape is written; both divergent keys survive.
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:d"]);
    const after = apply(DIVERGENT, result);
    expect((storedFrame(after, "shape:a") as CueFrame).stepOrderKey).toBe("a1");
    expect((storedFrame(after, "shape:b") as CueFrame).stepOrderKey).toBe("a9");
    // Re-derive: the divergence is still there, still diagnosable.
    expect(derive(after).diagnostics).toContainEqual({
      type: "step-key-divergence",
      stepId: "s1",
      shapeIds: ["shape:a", "shape:b"],
    });
  });

  it("dropping a foreign batch onto the divergent step converges nothing", () => {
    const doc = derive(DIVERGENT);
    const ui = calcFrameBatchUIData(doc);
    // Drop s2's batch (track V, index 1) AT the divergent step (index 0).
    const edited = moveFrame(ui.steps, ui.stepSources, "V", 1, 0, 0, "at");
    expect(edited).not.toBeNull();
    const result = reconcile(DIVERGENT, edited!);
    // Only the dragged cue is rewritten (joining s1 at the canonical
    // key); the divergent members are untouched.
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:c"]);
    const joined = result.updates[0].frame as CueFrame;
    expect(joined.stepId).toBe("s1");
    const after = apply(DIVERGENT, result);
    expect((storedFrame(after, "shape:b") as CueFrame).stepOrderKey).toBe("a9");
    expect(derive(after).diagnostics).toContainEqual({
      type: "step-key-divergence",
      stepId: "s1",
      shapeIds: ["shape:a", "shape:b", "shape:c"],
    });
  });

  // Same-track split: g1/g2 share stepId s1 AND track T; the derivation
  // displays g2 as a synthetic recovery step.
  const SPLIT: Entry[] = [
    { shapeId: "shape:a", frame: cue("g1", "s1", "a1", "T") },
    { shapeId: "shape:b", frame: cue("g2", "s1", "a1", "T") },
    { shapeId: "shape:c", frame: cue("g3", "s2", "a5", "U") },
  ];

  it("moving an unrelated step preserves the same-track split unmaterialized", () => {
    const doc = derive(SPLIT);
    expect(doc.steps).toHaveLength(3); // s1, synthetic, s2
    expect(doc.steps[1].synthetic).toEqual({
      reason: "same-track-split",
      sourceStepId: "s1",
    });
    const ui = calcFrameBatchUIData(doc);
    // Move the UNRELATED step s2 (track U, step index 2) to the front.
    const edited = moveFrame(ui.steps, ui.stepSources, "U", 2, 0, -1, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(SPLIT, edited!);
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:c"]);
    const after = apply(SPLIT, result);
    // Both conflicting cues still share the ORIGINAL stored stepId.
    expect((storedFrame(after, "shape:a") as CueFrame).stepId).toBe("s1");
    expect((storedFrame(after, "shape:b") as CueFrame).stepId).toBe("s1");
    // Re-derive: the synthetic step and its diagnostic remain.
    const rederived = derive(after);
    expect(rederived.steps.filter((s) => s.synthetic != null)).toHaveLength(1);
    expect(rederived.diagnostics).toContainEqual({
      type: "same-track-split",
      stepId: "s1",
      trackId: "T",
      shapeIds: ["shape:b"],
    });
  });

  it("dropping a foreign batch onto a synthetic recovery step is a no-op", () => {
    const doc = derive(SPLIT);
    const ui = calcFrameBatchUIData(doc);
    // Drop s2's batch (track U) AT the synthetic step (index 1).
    const edited = moveFrame(ui.steps, ui.stepSources, "U", 2, 0, 1, "at");
    expect(edited).not.toBeNull();
    const result = reconcile(SPLIT, edited!);
    // Pinned policy: synthetic steps are not editable through drags —
    // nothing is written, nothing is removed.
    expect(result.updates).toEqual([]);
    expect(result.removedShapeIds).toEqual([]);
  });

  it("dragging the split batch OUT of the synthetic step reconciles it alone", () => {
    const doc = derive(SPLIT);
    const ui = calcFrameBatchUIData(doc);
    // Move the synthetic step's batch (track T, step index 1) after s2:
    // unambiguous intent to relocate the split-off cue.
    const edited = moveFrame(ui.steps, ui.stepSources, "T", 1, 1, 2, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(SPLIT, edited!);
    // Only the dragged cue is rewritten — with a fresh stepId (it left
    // the shared step) and a key after s2. No other record changes.
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:b"]);
    const movedOut = result.updates[0].frame as CueFrame;
    expect(movedOut.stepId).not.toBe("s1");
    expect(movedOut.stepOrderKey > "a5").toBe(true);
    const after = apply(SPLIT, result);
    expect((storedFrame(after, "shape:a") as CueFrame).stepId).toBe("s1");
    expect(derive(after).diagnostics).toEqual([]);
  });

  it("a no-change round trip over every diagnostic class writes nothing", () => {
    const ALL: Entry[] = [
      // step-key-divergence
      { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
      { shapeId: "shape:b", frame: cue("f2", "s1", "a9", "U") },
      // same-track-split
      { shapeId: "shape:c", frame: cue("g1", "s2", "a3", "V") },
      { shapeId: "shape:d", frame: cue("g2", "s2", "a3", "V") },
      // duplicate-frame-id (two cues sharing "dup" in different steps)
      { shapeId: "shape:e", frame: cue("dup", "s3", "a5", "W") },
      { shapeId: "shape:f", frame: cue("dup", "s4", "a7", "X") },
      // detached sub frame
      { shapeId: "shape:z", frame: sub("h1", "missing-cue", "a0") },
    ];
    const doc = derive(ALL);
    expect(doc.diagnostics.map((d) => d.type).sort()).toEqual([
      "detached-sub-frame",
      "duplicate-frame-id",
      "same-track-split",
      "step-key-divergence",
    ]);
    const edited = toEditedSteps(calcFrameBatchUIData(doc));
    const result = reconcile(ALL, edited);
    expect(result.updates).toEqual([]);
    expect(result.removedShapeIds).toEqual([]);
  });
});
