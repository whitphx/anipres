// Reconciles a structurally edited timeline (the UI's EditedStep[] output —
// Timeline drag & drop, ControlPanel batch operations) back into per-shape
// v2 `meta.frame` values, preserving stored identities and keys wherever
// the edit left them valid so that writes stay local to what changed.
//
// This is the single write-back path that replaces v1's
// "rewrite every shape's meta from the new batch list" approach.
//
// SEMANTIC DIAGNOSTICS ARE NEVER AUTO-REPAIRED HERE. The derivation
// canonicalizes `step-key-divergence` and `same-track-split` in memory
// for playback, but persisting those repairs is reserved for the explicit
// diagnostic-resolution actions. Concretely:
// - A step the edit did not move keeps EACH member cue's own stored
//   `stepOrderKey`, divergent or not. Divergent keys converge only when
//   the edit itself moves the step (the new order requires a new key).
// - A rule-2 synthetic recovery step (`source.synthetic`) is TRANSPARENT
//   to structural edits: every frame listed under it keeps its stored
//   metadata verbatim — no step id is minted, no key is written, and a
//   frame dragged onto it is a no-op. Dragging a frame OUT of a synthetic
//   step into a normal step is unambiguous intent and reconciles
//   normally. Materializing the split is the explicit Resolve action's
//   job alone.

import type { CueFrame, EditedStep, Frame, SubFrame } from "./types";
import { isReservedStepId } from "./ids";
import { compareOrderKeys, deterministicKeysBetween } from "./keys";

export interface ReconcileInput {
  /** Current frames keyed by the shape carrying them. */
  currentFrames: { shapeId: string; frame: Frame }[];
  /** The edited timeline structure; array order = presentation order. */
  editedSteps: EditedStep[];
  /** Mints ids for new steps (injectable for deterministic tests). */
  mintId: () => string;
}

export interface ReconcileResult {
  /** Shapes whose `meta.frame` must be replaced with the given frame. */
  updates: { shapeId: string; frame: Frame }[];
  /** Shapes whose `meta.frame` must be removed entirely. */
  removedShapeIds: string[];
}

export function reconcileEditedSteps(input: ReconcileInput): ReconcileResult {
  const { currentFrames, editedSteps, mintId } = input;

  // Keyed by SHAPE id — the identity tldraw guarantees unique. Keying by
  // frame id would collapse duplicate frame ids (derivation rule 4 keeps
  // them lossless) onto one representative, and an unrelated Timeline edit
  // could then strip another shape's animation metadata.
  const currentByShapeId = new Map<string, { shapeId: string; frame: Frame }>();
  for (const entry of currentFrames) {
    if (!currentByShapeId.has(entry.shapeId)) {
      currentByShapeId.set(entry.shapeId, entry);
    }
  }

  const isSynthetic = (step: EditedStep) => step.source?.synthetic != null;

  // --- Assign step ids. Preference order: the SOURCE doc step's id
  // --- (stable even when the edit changes which batch leads the step),
  // --- then any stored stepId carried by the step's cues, then a mint.
  // --- Synthetic steps never claim or receive an id — their members'
  // --- stored stepId is left to the source step.
  const usedStepIds = new Set<string>();
  const stepIds: (string | null)[] = editedSteps.map((step) => {
    if (isSynthetic(step)) {
      return null;
    }
    const candidates: string[] = [];
    if (step.source != null) {
      candidates.push(step.source.id);
    }
    for (const batch of step.batches) {
      const cueRef = batch.frames[0];
      if (cueRef == null) continue;
      const existing = currentByShapeId.get(cueRef.shapeId);
      if (existing?.frame.type === "cue") {
        candidates.push(existing.frame.stepId);
      }
    }
    for (const candidate of candidates) {
      if (!usedStepIds.has(candidate) && !isReservedStepId(candidate)) {
        usedStepIds.add(candidate);
        return candidate;
      }
    }
    const minted = mintId();
    usedStepIds.add(minted);
    return minted;
  });

  // --- Assign step order keys: keep each step's stored canonical key when
  // --- it is still strictly ascending in the edited order; otherwise
  // --- generate keys between the previous assigned key and the next
  // --- keepable key. Writes stay local to the steps that actually moved.
  // --- Synthetic steps are excluded throughout (no key is ever written
  // --- for them).
  const storedKeyOf = (stepIndex: number): string | null => {
    const step = editedSteps[stepIndex];
    const stepId = stepIds[stepIndex];
    if (stepId == null) return null;
    // The key is keepable only if some cue in this step already stored
    // exactly this (stepId, key) pairing.
    for (const batch of step.batches) {
      const cueRef = batch.frames[0];
      if (cueRef == null) continue;
      const existing = currentByShapeId.get(cueRef.shapeId);
      if (existing?.frame.type === "cue" && existing.frame.stepId === stepId) {
        return existing.frame.stepOrderKey;
      }
    }
    return null;
  };

  // Keep the longest strictly-increasing subsequence of stored keys (the
  // steps that did NOT move) and re-key everything else between the kept
  // neighbors. The patience algorithm's smallest-tail preference means a
  // moved step's stale key is the one rewritten, not the unmoved steps
  // around it.
  const storedKeys: (string | null)[] = editedSteps.map((_, i) =>
    storedKeyOf(i),
  );
  const kept = new Set<number>();
  {
    const tails: number[] = []; // indices; storedKeys[tails[k]] = smallest tail of LIS length k+1
    const prev: number[] = new Array(editedSteps.length).fill(-1);
    for (let i = 0; i < storedKeys.length; i++) {
      const key = storedKeys[i];
      if (key == null) continue;
      // Binary search: first tail with key >= current key.
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareOrderKeys(storedKeys[tails[mid]]!, key) < 0) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    let cursor = tails.at(-1) ?? -1;
    while (cursor >= 0) {
      kept.add(cursor);
      cursor = prev[cursor];
    }
  }

  const assignedKeys: (string | null)[] = new Array(editedSteps.length);
  {
    // Synthetic steps are transparent: they receive no key and do not
    // count as slots in re-keyed gaps.
    let i = 0;
    let prevKey: string | null = null;
    while (i < editedSteps.length) {
      if (isSynthetic(editedSteps[i])) {
        assignedKeys[i] = null;
        i++;
        continue;
      }
      if (kept.has(i)) {
        assignedKeys[i] = storedKeys[i]!;
        prevKey = storedKeys[i]!;
        i++;
        continue;
      }
      const gap: number[] = [];
      let j = i;
      while (j < editedSteps.length && !kept.has(j)) {
        if (!isSynthetic(editedSteps[j])) {
          gap.push(j);
        }
        j++;
      }
      const upperBound = j < editedSteps.length ? storedKeys[j]! : null;
      const fresh = deterministicKeysBetween(prevKey, upperBound, gap.length);
      gap.forEach((stepIndex, freshIndex) => {
        assignedKeys[stepIndex] = fresh[freshIndex];
      });
      prevKey = fresh.at(-1) ?? prevKey;
      i = j;
    }
  }

  // --- Build the desired frame per edited frame ref.
  const desiredByShapeId = new Map<string, Frame>();
  editedSteps.forEach((step, stepIndex) => {
    if (isSynthetic(step)) {
      // Pinned policy: a synthetic recovery step is not editable through
      // structural drags. Every frame listed under it keeps its stored
      // metadata verbatim (a drag targeting it is a no-op), preserving
      // the same-track-split diagnostic until explicitly resolved.
      for (const batch of step.batches) {
        for (const ref of batch.frames) {
          const entry = currentByShapeId.get(ref.shapeId);
          if (entry != null) {
            desiredByShapeId.set(entry.shapeId, entry.frame);
          }
        }
      }
      return;
    }
    const stepId = stepIds[stepIndex]!;
    const stepKey = assignedKeys[stepIndex]!;
    const stepWasMoved = !kept.has(stepIndex);
    for (const batch of step.batches) {
      const [cueRef, ...subRefs] = batch.frames;
      if (cueRef == null) continue;
      const cueEntry = currentByShapeId.get(cueRef.shapeId);
      if (cueEntry == null) continue; // refs must point at existing frames

      // Divergence preservation: an UNMOVED step keeps each member cue's
      // own stored stepOrderKey (equal to the canonical key in healthy
      // documents; intentionally different under step-key-divergence,
      // which only the explicit Resolve action converges). A MOVED step
      // requires a new order, so all members adopt the assigned key.
      const keepOwnStoredKey =
        !stepWasMoved &&
        cueEntry.frame.type === "cue" &&
        cueEntry.frame.stepId === stepId;
      const cueFrame: CueFrame = {
        v: 2,
        // The stored frame id is relationship data and is never changed by
        // structural edits — sub frames reference the batch through it.
        id: cueEntry.frame.id,
        type: "cue",
        trackId: batch.trackId,
        stepId,
        stepOrderKey: keepOwnStoredKey
          ? (cueEntry.frame as CueFrame).stepOrderKey
          : stepKey,
        action: cueRef.action,
      };
      desiredByShapeId.set(cueEntry.shapeId, cueFrame);

      // Sub frames: keep stored orderKeys when the batch membership and
      // relative order are unchanged; otherwise regenerate the batch's
      // sub-key chain (writes bounded to this batch).
      const storedSubKeys = subRefs.map((ref) => {
        const entry = currentByShapeId.get(ref.shapeId);
        return entry?.frame.type === "sub" &&
          entry.frame.cueFrameId === cueEntry.frame.id
          ? entry.frame.orderKey
          : null;
      });
      const keysAreValid =
        storedSubKeys.every((k) => k != null) &&
        storedSubKeys.every(
          (k, idx) =>
            idx === 0 || compareOrderKeys(storedSubKeys[idx - 1]!, k!) < 0,
        );
      const subKeys = keysAreValid
        ? (storedSubKeys as string[])
        : deterministicKeysBetween(null, null, subRefs.length);

      subRefs.forEach((ref, index) => {
        const entry = currentByShapeId.get(ref.shapeId);
        if (entry == null) return;
        const subFrame: SubFrame = {
          v: 2,
          id: entry.frame.id,
          type: "sub",
          cueFrameId: cueEntry.frame.id,
          orderKey: subKeys[index],
          action: ref.action,
        };
        desiredByShapeId.set(entry.shapeId, subFrame);
      });
    }
  });

  // Detached sub frames — dangling cueFrameId, derivation rule 3 — never
  // appear in doc.steps, so the UI's EditedStep[] cannot reference them.
  // Their absence from an edit is therefore NOT a deletion: they survive
  // untouched ("detached, surfaced, never dropped"). Mirrors derivation
  // attachment: a sub is detached iff no current CUE carries its
  // cueFrameId.
  const currentCueFrameIds = new Set(
    currentFrames
      .filter((entry) => entry.frame.type === "cue")
      .map((entry) => entry.frame.id),
  );

  // --- Diff against current state; only changed frames become writes.
  const updates: ReconcileResult["updates"] = [];
  const removedShapeIds: string[] = [];
  const seenShapeIds = new Set<string>();
  for (const { shapeId, frame } of currentFrames) {
    if (seenShapeIds.has(shapeId)) continue;
    seenShapeIds.add(shapeId);
    const desired = desiredByShapeId.get(shapeId);
    if (desired == null) {
      if (frame.type === "sub" && !currentCueFrameIds.has(frame.cueFrameId)) {
        continue; // detached — unreferencable by edits, never removed
      }
      removedShapeIds.push(shapeId);
      continue;
    }
    // Key-order-sensitive comparison — safe ONLY because both sides are
    // built by frame constructors in this module family with a fixed
    // property order. If either side ever comes from foreign JSON, this
    // must become a field-wise comparison (the failure mode is a spurious
    // full-document rewrite).
    if (JSON.stringify(desired) !== JSON.stringify(frame)) {
      updates.push({ shapeId, frame: desired });
    }
  }

  return { updates, removedShapeIds: removedShapeIds.sort() };
}
