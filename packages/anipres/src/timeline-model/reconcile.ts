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
//   frame dragged onto it is a no-op. An edit that restructures the
//   split batch ITSELF is different: dragging it out of the synthetic
//   step, or a same-track drag whose push sweep crosses it (the sweep
//   re-emits swept batches as sourceless new steps), materializes the
//   split — the batch genuinely took part in that edit. Outside those
//   cases, materializing is the explicit Resolve action's job alone.
//   (Both are pinned by semantic-preservation.test.ts.)
// - Transparency must not CREATE diagnostics either: a step carrying
//   split-off members is pinned to its stored key so unrelated moves
//   never re-key it around its frozen siblings, and if re-keying it is
//   unavoidable, the split members follow it to the same key — an
//   ordinary drag can neither repair nor fabricate a divergence.

import { TIMELINE_FORMAT_VERSION } from "./types";
import type { CueFrame, EditedStep, Frame, SubFrame } from "./types";
import { isReservedStepId } from "./ids";
import { compareOrderKeys, orderKeysBetween } from "./order-key";

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

  // --- Assign step ids in TWO PHASES so identity ownership does not
  // --- depend on edited-array order:
  // --- 1. Every surviving sourced step RESERVES its (valid,
  // ---    non-synthetic) source id — an unsourced step must never steal
  // ---    a stored identity whose owner is still present (e.g. a batch
  // ---    split out of a step and placed BEFORE the surviving step
  // ---    would otherwise claim the stored stepId via its cue and force
  // ---    a mint onto the stationary step).
  // --- 2. Remaining steps reuse an unreserved stored cue stepId, or
  // ---    mint. Synthetic steps never claim or receive an id.
  const usedStepIds = new Set<string>();
  const stepIds: (string | null)[] = new Array(editedSteps.length).fill(null);
  editedSteps.forEach((step, i) => {
    if (isSynthetic(step)) return;
    const sourceId = step.source?.id;
    if (
      sourceId != null &&
      !isReservedStepId(sourceId) &&
      !usedStepIds.has(sourceId)
    ) {
      usedStepIds.add(sourceId);
      stepIds[i] = sourceId;
    }
  });
  editedSteps.forEach((step, i) => {
    if (isSynthetic(step) || stepIds[i] != null) return;
    for (const batch of step.batches) {
      const cueRef = batch.frames[0];
      if (cueRef == null) continue;
      const existing = currentByShapeId.get(cueRef.shapeId);
      const candidate =
        existing?.frame.type === "cue" ? existing.frame.stepId : undefined;
      if (
        candidate != null &&
        !usedStepIds.has(candidate) &&
        !isReservedStepId(candidate)
      ) {
        usedStepIds.add(candidate);
        stepIds[i] = candidate;
        return;
      }
    }
    const minted = mintId();
    usedStepIds.add(minted);
    stepIds[i] = minted;
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
    // A step that RETAINED its source identity keeps the source's
    // canonical key as its authoritative stored key. This matters when
    // no current cue can supply the (stepId, key) pairing — e.g. the
    // surviving step is led only by a promoted sub frame after a batch
    // was split out — where a cue-only scan would force a needless
    // re-key.
    if (
      step.source != null &&
      step.source.synthetic == null &&
      step.source.id === stepId
    ) {
      return step.source.orderKey;
    }
    // Otherwise the key is keepable only if some cue in this step
    // already stored exactly this (stepId, key) pairing.
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

  /** Patience LIS over non-null keys; returns the kept local indices. */
  const longestIncreasingIndices = (keys: (string | null)[]): Set<number> => {
    const tails: number[] = [];
    const prev: number[] = new Array(keys.length).fill(-1);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key == null) continue;
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (compareOrderKeys(keys[tails[mid]]!, key) < 0) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const kept = new Set<number>();
    let cursor = tails.at(-1) ?? -1;
    while (cursor >= 0) {
      kept.add(cursor);
      cursor = prev[cursor];
    }
    return kept;
  };

  // A step that carries split-off members (its assigned stepId is the
  // sourceStepId of a synthetic step in this edit) shares its key with
  // FROZEN synthetic members — re-keying it would either fabricate a
  // step-key-divergence or force writes to the split members. So such
  // steps are PINNED: they keep their stored key whenever the pinned
  // keys are mutually consistent, and the re-key blame falls on the
  // other steps (typically the one the user actually dragged).
  const splitSourceStepIds = new Set(
    editedSteps.flatMap((step) =>
      step.source?.synthetic != null
        ? [step.source.synthetic.sourceStepId]
        : [],
    ),
  );
  const kept = new Set<number>();
  {
    const pinnedIndices: number[] = [];
    for (let i = 0; i < editedSteps.length; i++) {
      const stepId = stepIds[i];
      if (
        stepId != null &&
        splitSourceStepIds.has(stepId) &&
        storedKeys[i] != null
      ) {
        pinnedIndices.push(i);
      }
    }
    // Mutually inconsistent pinned keys (only possible when several
    // split-carrying steps were reordered against each other): keep the
    // largest consistent subset; the rest fall through to the safety net
    // below, which moves their split members WITH them.
    const pinnedKeptLocal = longestIncreasingIndices(
      pinnedIndices.map((i) => storedKeys[i]!),
    );
    const pinnedKept = [...pinnedKeptLocal].map((li) => pinnedIndices[li]);
    for (const i of pinnedKept) {
      kept.add(i);
    }
    // Between consecutive pinned boundaries, keep the longest increasing
    // run of stored keys that fits STRICTLY inside the boundary keys.
    const boundaries = [...pinnedKept].sort((a, b) => a - b);
    const segments: { lo: number; hi: number }[] = [];
    let start = 0;
    for (const boundary of boundaries) {
      segments.push({ lo: start, hi: boundary });
      start = boundary + 1;
    }
    segments.push({ lo: start, hi: editedSteps.length });
    for (const { lo, hi } of segments) {
      const lowerKey = lo > 0 ? (storedKeys[lo - 1] ?? null) : null;
      const upperKey = hi < editedSteps.length ? storedKeys[hi]! : null;
      const localKeys: (string | null)[] = [];
      const localToGlobal: number[] = [];
      for (let i = lo; i < hi; i++) {
        const key = storedKeys[i];
        const fits =
          key != null &&
          (lowerKey == null || compareOrderKeys(lowerKey, key) < 0) &&
          (upperKey == null || compareOrderKeys(key, upperKey) < 0);
        localKeys.push(fits ? key : null);
        localToGlobal.push(i);
      }
      for (const li of longestIncreasingIndices(localKeys)) {
        kept.add(localToGlobal[li]);
      }
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
      const fresh = orderKeysBetween(prevKey, upperBound, gap.length);
      gap.forEach((stepIndex, freshIndex) => {
        assignedKeys[stepIndex] = fresh[freshIndex];
      });
      prevKey = fresh.at(-1) ?? prevKey;
      i = j;
    }
  }

  // --- Build the desired frame per edited frame ref.
  const stepIndexByStepId = new Map<string, number>();
  stepIds.forEach((id, i) => {
    if (id != null && !stepIndexByStepId.has(id)) {
      stepIndexByStepId.set(id, i);
    }
  });
  const desiredByShapeId = new Map<string, Frame>();
  editedSteps.forEach((step, stepIndex) => {
    if (isSynthetic(step)) {
      // Pinned policy: a synthetic recovery step is not editable through
      // structural drags. Every frame listed under it keeps its stored
      // metadata verbatim (a drag targeting it is a no-op), preserving
      // the same-track-split diagnostic until explicitly resolved.
      //
      // ONE exception — the divergence safety net: when the SOURCE step
      // (whose stepId the split members share) is being re-keyed by this
      // edit, the split members must follow it to the same key. Leaving
      // them frozen at the old key would fabricate a brand-new
      // step-key-divergence (two cues, one stepId, different keys) out
      // of an ordinary drag. Pinning (above) makes this path rare; it
      // fires only when keeping the source step's key was impossible.
      for (const batch of step.batches) {
        for (const ref of batch.frames) {
          const entry = currentByShapeId.get(ref.shapeId);
          if (entry == null) continue;
          let desired = entry.frame;
          if (entry.frame.type === "cue") {
            const sourceIndex = stepIndexByStepId.get(entry.frame.stepId);
            const followKey =
              sourceIndex != null && !kept.has(sourceIndex)
                ? assignedKeys[sourceIndex]
                : null;
            if (followKey != null && entry.frame.stepOrderKey !== followKey) {
              desired = { ...entry.frame, stepOrderKey: followKey };
            }
          }
          desiredByShapeId.set(entry.shapeId, desired);
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
        v: TIMELINE_FORMAT_VERSION,
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
        : orderKeysBetween(null, null, subRefs.length);

      subRefs.forEach((ref, index) => {
        const entry = currentByShapeId.get(ref.shapeId);
        if (entry == null) return;
        const subFrame: SubFrame = {
          v: TIMELINE_FORMAT_VERSION,
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
