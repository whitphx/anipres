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

  it("a same-track sweep crossing the split batch materializes it (pinned)", () => {
    // The pinned drag semantics push EVERY same-track batch between
    // source and destination — a split batch in the sweep path is
    // restructured like any other batch (it genuinely takes part in this
    // edit, unlike the unrelated-track moves above), so the sweep
    // materializes it as its own stored step. This is the one structural
    // edit allowed to persist a split, because the drag itself
    // restructures the batch.
    const SWEEP: Entry[] = [
      { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
      { shapeId: "shape:b", frame: cue("f2", "s1", "a1", "T") }, // synthetic
      { shapeId: "shape:c", frame: cue("f3", "s2", "a2", "T") }, // same track
    ];
    const doc = derive(SWEEP);
    expect(doc.diagnostics.map((d) => d.type)).toEqual(["same-track-split"]);
    const ui = calcFrameBatchUIData(doc);
    // Drag s2's track-T batch (step 2) left past the synthetic step: the
    // sweep range contains the split batch, so it is pushed along. In
    // this minimal arrangement the pushed batches land back in the same
    // visible order (a, b, c) — the assertion below pinning an unchanged
    // order is correct, not a bug; the persisted effect of the drag is
    // the materialization itself.
    const edited = moveFrame(ui.steps, ui.stepSources, "T", 2, 2, 0, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(SWEEP, edited!);
    expect(result.removedShapeIds).toEqual([]);
    // The swept split cue lands in its own real step: fresh stepId,
    // keyed between the source step and s2.
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:b"]);
    const swept = result.updates[0].frame as CueFrame;
    expect(swept.stepId).not.toBe("s1");
    expect(swept.stepOrderKey > "a1" && swept.stepOrderKey < "a2").toBe(true);
    const after = apply(SWEEP, result);
    const rederived = derive(after);
    expect(rederived.diagnostics).toEqual([]);
    expect(rederived.steps.map((s) => s.batches[0].frames[0].shapeId)).toEqual([
      "shape:a",
      "shape:b",
      "shape:c",
    ]);
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

describe("re-keying around split-carrying steps never creates divergence", () => {
  // Reviewer repro: [s0 "a0" U:u] [s1 "a1" T:a] [synthetic "a1" T:b].
  // Dragging U's step after step 1 used to make the LIS blame s1 (stored
  // keys [a1, a0] descend), re-keying shape:a while shape:b stayed
  // frozen at "a1" — fabricating a step-key-divergence.
  const SPLIT_AND_NEIGHBOR: Entry[] = [
    { shapeId: "shape:u", frame: cue("u1", "s0", "a0", "U") },
    { shapeId: "shape:a", frame: cue("t1", "s1", "a1", "T") },
    { shapeId: "shape:b", frame: cue("t2", "s1", "a1", "T") },
  ];

  it("re-keys the dragged step, not the split-carrying one (reviewer repro)", () => {
    const doc = derive(SPLIT_AND_NEIGHBOR);
    expect(doc.diagnostics.map((d) => d.type)).toEqual(["same-track-split"]);
    const ui = calcFrameBatchUIData(doc);
    // Drag U's step (index 0) to "after" step 1.
    const edited = moveFrame(ui.steps, ui.stepSources, "U", 0, 0, 1, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(SPLIT_AND_NEIGHBOR, edited!);
    // The split-carrying step is pinned: only the DRAGGED shape is
    // written, to a key above the pinned "a1".
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:u"]);
    const movedKey = (result.updates[0].frame as CueFrame).stepOrderKey;
    expect(movedKey > "a1").toBe(true);
    const after = apply(SPLIT_AND_NEIGHBOR, result);
    expect((storedFrame(after, "shape:a") as CueFrame).stepOrderKey).toBe("a1");
    expect((storedFrame(after, "shape:b") as CueFrame).stepOrderKey).toBe("a1");
    // Re-derive: still exactly ONE diagnostic — no divergence appeared.
    expect(derive(after).diagnostics.map((d) => d.type)).toEqual([
      "same-track-split",
    ]);
  });

  it("split members follow their source step when re-keying it is unavoidable", () => {
    // Two split clusters whose pinned keys conflict in the edited order
    // (s1 @ a5 placed before s2 @ a3): only one can keep its key; the
    // other's split member must FOLLOW to the same new key.
    const TWO_SPLITS: Entry[] = [
      { shapeId: "shape:a", frame: cue("f1", "s1", "a5", "T") },
      { shapeId: "shape:b", frame: cue("f2", "s1", "a5", "T") },
      { shapeId: "shape:c", frame: cue("g1", "s2", "a3", "U") },
      { shapeId: "shape:d", frame: cue("g2", "s2", "a3", "U") },
    ];
    const edited: EditedStep[] = [
      {
        source: { id: "s1", orderKey: "a5" },
        batches: [
          {
            trackId: "T",
            frames: [{ shapeId: "shape:a", frameId: "f1", action: ACTION }],
          },
        ],
      },
      {
        source: {
          id: "synthstep:s1",
          orderKey: "a5",
          synthetic: { reason: "same-track-split", sourceStepId: "s1" },
        },
        batches: [
          {
            trackId: "T",
            frames: [{ shapeId: "shape:b", frameId: "f2", action: ACTION }],
          },
        ],
      },
      {
        source: { id: "s2", orderKey: "a3" },
        batches: [
          {
            trackId: "U",
            frames: [{ shapeId: "shape:c", frameId: "g1", action: ACTION }],
          },
        ],
      },
      {
        source: {
          id: "synthstep:s2",
          orderKey: "a3",
          synthetic: { reason: "same-track-split", sourceStepId: "s2" },
        },
        batches: [
          {
            trackId: "U",
            frames: [{ shapeId: "shape:d", frameId: "g2", action: ACTION }],
          },
        ],
      },
    ];
    const result = reconcile(TWO_SPLITS, edited);
    expect(result.removedShapeIds).toEqual([]);
    // s1 had to be re-keyed below a3; BOTH its members moved together.
    expect(result.updates.map((u) => u.shapeId).sort()).toEqual([
      "shape:a",
      "shape:b",
    ]);
    const aFrame = result.updates.find((u) => u.shapeId === "shape:a")!
      .frame as CueFrame;
    const bFrame = result.updates.find((u) => u.shapeId === "shape:b")!
      .frame as CueFrame;
    expect(aFrame.stepOrderKey).toBe(bFrame.stepOrderKey); // no divergence
    expect(aFrame.stepOrderKey < "a3").toBe(true);
    expect(bFrame.stepId).toBe("s1"); // still NOT materialized
    const after = apply(TWO_SPLITS, result);
    const rederived = derive(after);
    // Both splits survive; no divergence was fabricated.
    expect(rederived.diagnostics.map((d) => d.type).sort()).toEqual([
      "same-track-split",
      "same-track-split",
    ]);
  });
});

describe("sourced step identity reservation (two-phase assignment)", () => {
  // Stored step s1 fires two batches simultaneously: track T (cue A) and
  // track U (cue B). Splitting batch T out into a NEW step must leave the
  // stored identity with the SURVIVING sourced step — regardless of
  // whether the new step lands before or after it in the edited order.
  const SIMULTANEOUS: Entry[] = [
    { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
    { shapeId: "shape:b", frame: cue("f2", "s1", "a1", "U") },
  ];

  it("splitting a batch out BEFORE the surviving step leaves s1 with the survivor", () => {
    const doc = derive(SIMULTANEOUS);
    expect(doc.steps).toHaveLength(1);
    const ui = calcFrameBatchUIData(doc);
    // Move batch T of step 0 to before everything.
    const edited = moveFrame(ui.steps, ui.stepSources, "T", 0, 0, -1, "after");
    expect(edited).not.toBeNull();
    // The new unsourced step comes FIRST in display order — without the
    // reservation phase it would claim s1 via its cue's stored stepId.
    const result = reconcile(SIMULTANEOUS, edited!);
    // Only the moved batch's cue is rewritten; the stationary one is not.
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:a"]);
    const moved = result.updates[0].frame as CueFrame;
    expect(moved.stepId).not.toBe("s1"); // fresh identity for the split
    expect(moved.stepOrderKey < "a1").toBe(true);
    const after = apply(SIMULTANEOUS, result);
    expect(storedFrame(after, "shape:b")).toEqual(cue("f2", "s1", "a1", "U"));
    const rederived = derive(after);
    expect(rederived.steps).toHaveLength(2);
    expect(rederived.steps[1].id).toBe("s1"); // survivor owns the identity
    expect(rederived.diagnostics).toEqual([]);
  });

  it("splitting a batch out AFTER the surviving step behaves identically", () => {
    const doc = derive(SIMULTANEOUS);
    const ui = calcFrameBatchUIData(doc);
    const edited = moveFrame(ui.steps, ui.stepSources, "T", 0, 0, 0, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(SIMULTANEOUS, edited!);
    expect(result.removedShapeIds).toEqual([]);
    expect(result.updates.map((u) => u.shapeId)).toEqual(["shape:a"]);
    const moved = result.updates[0].frame as CueFrame;
    expect(moved.stepId).not.toBe("s1");
    expect(moved.stepOrderKey > "a1").toBe(true);
    const after = apply(SIMULTANEOUS, result);
    expect(storedFrame(after, "shape:b")).toEqual(cue("f2", "s1", "a1", "U"));
    const rederived = derive(after);
    expect(rederived.steps).toHaveLength(2);
    expect(rederived.steps[0].id).toBe("s1"); // same ownership, other order
    expect(rederived.diagnostics).toEqual([]);
  });

  it("a surviving step led by a promoted sub keeps source id AND key (no re-key)", () => {
    // Batch [cue A, sub S] on track T; dragging the cue out leaves S
    // promoted as the surviving step's cue. No current cue stores the
    // (s1, a1) pairing, so only source.orderKey can keep the step's key.
    const PROMOTION: Entry[] = [
      { shapeId: "shape:a", frame: cue("f1", "s1", "a1", "T") },
      { shapeId: "shape:s", frame: sub("f2", "f1", "a0") },
    ];
    const doc = derive(PROMOTION);
    const ui = calcFrameBatchUIData(doc);
    // Drag the cue (trackIndex 0) out to the front.
    const edited = moveFrame(ui.steps, ui.stepSources, "T", 0, 0, -1, "after");
    expect(edited).not.toBeNull();
    const result = reconcile(PROMOTION, edited!);
    expect(result.removedShapeIds).toEqual([]);
    // Exactly the two directly involved shapes are written: the dragged
    // cue (fresh step) and the promoted sub (now a cue) — which RETAINS
    // the source step's id and canonical key.
    expect(result.updates.map((u) => u.shapeId).sort()).toEqual([
      "shape:a",
      "shape:s",
    ]);
    const promoted = result.updates.find((u) => u.shapeId === "shape:s")!
      .frame as CueFrame;
    expect(promoted.type).toBe("cue");
    expect(promoted.stepId).toBe("s1");
    expect(promoted.stepOrderKey).toBe("a1"); // no needless re-key
    const dragged = result.updates.find((u) => u.shapeId === "shape:a")!
      .frame as CueFrame;
    expect(dragged.stepId).not.toBe("s1");
    expect(dragged.stepOrderKey < "a1").toBe(true);
  });
});
