// Reconciles a structurally edited timeline (the UI's EditedStep[] output —
// Timeline drag & drop, ControlPanel batch operations) back into per-shape
// v2 `meta.frame` values, preserving stored identities and keys wherever
// the edit left them valid so that writes stay local to what changed.
//
// This is the single write-back path that replaces v1's
// "rewrite every shape's meta from the new batch list" approach.

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

  // --- Assign step ids: reuse the stored stepId of the first batch's cue
  // --- when it isn't claimed by an earlier edited step; mint otherwise.
  const usedStepIds = new Set<string>();
  const stepIds: string[] = editedSteps.map((step) => {
    const firstCueRef = step[0]?.frames[0];
    const existing = firstCueRef
      ? currentByShapeId.get(firstCueRef.shapeId)
      : undefined;
    const candidate =
      existing?.frame.type === "cue" ? existing.frame.stepId : undefined;
    if (
      candidate != null &&
      !usedStepIds.has(candidate) &&
      !isReservedStepId(candidate)
    ) {
      usedStepIds.add(candidate);
      return candidate;
    }
    const minted = mintId();
    usedStepIds.add(minted);
    return minted;
  });

  // --- Assign step order keys: keep each step's stored canonical key when
  // --- it is still strictly ascending in the edited order; otherwise
  // --- generate keys between the previous assigned key and the next
  // --- keepable key. Writes stay local to the steps that actually moved.
  const storedKeyOf = (stepIndex: number): string | null => {
    const step = editedSteps[stepIndex];
    const stepId = stepIds[stepIndex];
    // The key is keepable only if some cue in this step already stored
    // exactly this (stepId, key) pairing.
    for (const batch of step) {
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

  const assignedKeys: string[] = new Array(editedSteps.length);
  {
    let i = 0;
    let prevKey: string | null = null;
    while (i < editedSteps.length) {
      if (kept.has(i)) {
        assignedKeys[i] = storedKeys[i]!;
        prevKey = storedKeys[i]!;
        i++;
        continue;
      }
      let j = i;
      while (j < editedSteps.length && !kept.has(j)) {
        j++;
      }
      const upperBound = j < editedSteps.length ? storedKeys[j]! : null;
      const fresh = deterministicKeysBetween(prevKey, upperBound, j - i);
      for (let k = i; k < j; k++) {
        assignedKeys[k] = fresh[k - i];
      }
      prevKey = fresh.at(-1) ?? prevKey;
      i = j;
    }
  }

  // --- Build the desired frame per edited frame ref.
  const desiredByShapeId = new Map<string, Frame>();
  editedSteps.forEach((step, stepIndex) => {
    for (const batch of step) {
      const [cueRef, ...subRefs] = batch.frames;
      if (cueRef == null) continue;
      const cueEntry = currentByShapeId.get(cueRef.shapeId);
      if (cueEntry == null) continue; // refs must point at existing frames

      const cueFrame: CueFrame = {
        v: 2,
        // The stored frame id is relationship data and is never changed by
        // structural edits — sub frames reference the batch through it.
        id: cueEntry.frame.id,
        type: "cue",
        trackId: batch.trackId,
        stepId: stepIds[stepIndex],
        stepOrderKey: assignedKeys[stepIndex],
        action: cueRef.action,
      };
      desiredByShapeId.set(cueEntry.shapeId, cueFrame);

      // Sub frames: keep stored orderKeys when the batch membership and
      // relative order are unchanged; otherwise regenerate the batch's
      // sub-key chain (writes bounded to this batch).
      const storedKeys = subRefs.map((ref) => {
        const entry = currentByShapeId.get(ref.shapeId);
        return entry?.frame.type === "sub" &&
          entry.frame.cueFrameId === cueEntry.frame.id
          ? entry.frame.orderKey
          : null;
      });
      const keysAreValid =
        storedKeys.every((k) => k != null) &&
        storedKeys.every(
          (k, idx) =>
            idx === 0 || compareOrderKeys(storedKeys[idx - 1]!, k!) < 0,
        );
      const subKeys = keysAreValid
        ? (storedKeys as string[])
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

  // --- Diff against current state; only changed frames become writes.
  const updates: ReconcileResult["updates"] = [];
  const removedShapeIds: string[] = [];
  const seenShapeIds = new Set<string>();
  for (const { shapeId, frame } of currentFrames) {
    if (seenShapeIds.has(shapeId)) continue;
    seenShapeIds.add(shapeId);
    const desired = desiredByShapeId.get(shapeId);
    if (desired == null) {
      removedShapeIds.push(shapeId);
      continue;
    }
    if (JSON.stringify(desired) !== JSON.stringify(frame)) {
      updates.push({ shapeId, frame: desired });
    }
  }

  return { updates, removedShapeIds: removedShapeIds.sort() };
}
