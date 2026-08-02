// Deterministic v1 → v2 migration.
// Spec: docs/design-animation-data-model.md — "Migration from v1".
//
// Everything here is a pure function of its inputs so that:
// - migration is idempotent,
// - concurrent migrations of the same document write byte-identical
//   records and converge under per-record last-writer-wins,
// - converting any subset of records (mixed v1/v2 documents) matches a
//   complete migration — via GROUP RECONSTRUCTION, since partitionIndex
//   depends on the whole original group, not the individual record.

import type { CueFrame, Frame, SubFrame } from "./types";
import type { LegacyCueFrame, LegacyFrame, LegacySubFrame } from "./parse";
import { makeMigratedStepId, parseMigratedStepId } from "./ids";
import {
  getMigratedStepOrderKey,
  getMigratedSubFrameOrderKey,
} from "./order-key";

export interface ShapeLegacyFrame {
  shapeId: string;
  frame: LegacyFrame;
}
export interface ShapeV2Frame {
  shapeId: string;
  frame: Frame;
}

export type MigrationDiagnostic =
  | {
      type: "conflict-partitioned";
      globalIndex: number;
      trackId: string;
      shapeIds: string[];
    }
  | { type: "forked-sub-chain"; prevFrameId: string; shapeIds: string[] }
  | { type: "dangling-sub-chain"; shapeId: string; missingFrameId: string }
  | {
      type: "degenerate-persisted-partition";
      stepId: string;
      trackId: string;
    };

export interface MigrationResult {
  /** Per-shape replacement `meta.frame` values (v2). */
  updates: { shapeId: string; frame: Frame }[];
  diagnostics: MigrationDiagnostic[];
  /**
   * Sub frames whose chains never reach a cue. They are still migrated (as
   * v2 sub frames whose `cueFrameId` dangles → derivation rule 3 surfaces
   * them as detached) — nothing is permanently discarded — and listed here
   * for inspection.
   */
  detachedFrames: { shapeId: string; frame: LegacyFrame }[];
}

interface CueSlot {
  shapeId: string;
  frame: LegacyCueFrame;
}

/**
 * Deterministic first-fit partition assignment within one v1 `globalIndex`
 * group. A v2 step holds at most one batch per track, so same-track
 * conflicts land in partitions 1, 2, … as adjacent steps. Partitions
 * already persisted by v2 records (recovered from parsed `v1step:` ids)
 * are reserved — including their track occupancy — before the remaining v1
 * cues are assigned in `(frame.id, shape.id)` order, so a partial
 * migration resumes to the identical assignment a complete migration
 * would have produced.
 */
function assignPartitions(
  v1Cues: CueSlot[],
  reservedByPartition: Map<number, Set<string>>,
  diagnostics: MigrationDiagnostic[],
  globalIndex: number,
): Map<string, number> {
  const sorted = [...v1Cues].sort((a, b) =>
    a.frame.id !== b.frame.id
      ? a.frame.id < b.frame.id
        ? -1
        : 1
      : a.shapeId < b.shapeId
        ? -1
        : a.shapeId > b.shapeId
          ? 1
          : 0,
  );

  const occupancy = new Map<number, Set<string>>();
  for (const [partition, tracks] of reservedByPartition) {
    occupancy.set(partition, new Set(tracks));
  }

  const assignment = new Map<string, number>(); // shapeId -> partition
  const conflictShapeIdsByTrack = new Map<string, string[]>();

  for (const cue of sorted) {
    const trackId = cue.frame.trackId;
    let partition = 0;
    for (;;) {
      const tracks = occupancy.get(partition);
      if (tracks == null || !tracks.has(trackId)) {
        break;
      }
      partition++;
    }
    const tracks = occupancy.get(partition) ?? new Set<string>();
    tracks.add(trackId);
    occupancy.set(partition, tracks);
    assignment.set(cue.shapeId, partition);

    if (partition > 0) {
      const shapeIds = conflictShapeIdsByTrack.get(trackId) ?? [];
      shapeIds.push(cue.shapeId);
      conflictShapeIdsByTrack.set(trackId, shapeIds);
    }
  }

  for (const [trackId, shapeIds] of conflictShapeIdsByTrack) {
    diagnostics.push({
      type: "conflict-partitioned",
      globalIndex,
      trackId,
      shapeIds,
    });
  }

  return assignment;
}

/**
 * Migrates v1 frames to v2, reconstructing each original `globalIndex`
 * group from BOTH the raw v1 cue frames and the already-migrated v2 cue
 * frames whose `v1step:` ids parse back to coordinates for this page.
 *
 * `existingV2Frames` are the document's current v2 frames (used only for
 * partition reservation); they are never rewritten by migration —
 * degenerate persisted partitions are kept and diagnosed, falling through
 * to derivation rule 2.
 */
export function migrateV1Frames(
  v1Frames: ShapeLegacyFrame[],
  existingV2Frames: ShapeV2Frame[],
  pageId: string,
): MigrationResult {
  const diagnostics: MigrationDiagnostic[] = [];
  const detachedFrames: MigrationResult["detachedFrames"] = [];
  const updates: MigrationResult["updates"] = [];

  // Deterministic iteration order regardless of input order.
  const sortedV1 = [...v1Frames].sort((a, b) =>
    a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
  );

  const v1Cues: CueSlot[] = [];
  const v1Subs: { shapeId: string; frame: LegacySubFrame }[] = [];
  for (const entry of sortedV1) {
    if (entry.frame.type === "cue") {
      v1Cues.push({ shapeId: entry.shapeId, frame: entry.frame });
    } else {
      v1Subs.push({ shapeId: entry.shapeId, frame: entry.frame });
    }
  }

  // --- Group reconstruction: reserved partitions from persisted v2 ids.
  const reservedByGroup = new Map<number, Map<number, Set<string>>>();
  const seenPersisted = new Map<string, Set<string>>(); // stepId -> tracks
  for (const { frame } of existingV2Frames) {
    if (frame.type !== "cue") continue;
    const coords = parseMigratedStepId(frame.stepId);
    if (coords == null || coords.pageId !== pageId) continue;
    const byPartition =
      reservedByGroup.get(coords.globalIndex) ?? new Map<number, Set<string>>();
    const tracks = byPartition.get(coords.partitionIndex) ?? new Set<string>();
    if (tracks.has(frame.trackId)) {
      // Two persisted same-track cues claiming one partition: degenerate
      // input from corrupted writes. Kept as-is and diagnosed — migration
      // never "corrects" persisted v2 records.
      const seen = seenPersisted.get(frame.stepId) ?? new Set<string>();
      if (!seen.has(frame.trackId)) {
        diagnostics.push({
          type: "degenerate-persisted-partition",
          stepId: frame.stepId,
          trackId: frame.trackId,
        });
        seen.add(frame.trackId);
        seenPersisted.set(frame.stepId, seen);
      }
    }
    tracks.add(frame.trackId);
    byPartition.set(coords.partitionIndex, tracks);
    reservedByGroup.set(coords.globalIndex, byPartition);
  }

  // --- Cue frames: coordinates → deterministic stepId + stepOrderKey.
  const cuesByGroup = new Map<number, CueSlot[]>();
  for (const cue of v1Cues) {
    const group = cuesByGroup.get(cue.frame.globalIndex) ?? [];
    group.push(cue);
    cuesByGroup.set(cue.frame.globalIndex, group);
  }

  for (const [globalIndex, group] of [...cuesByGroup.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const reserved =
      reservedByGroup.get(globalIndex) ?? new Map<number, Set<string>>();
    const partitionByShapeId = assignPartitions(
      group,
      reserved,
      diagnostics,
      globalIndex,
    );
    for (const cue of group) {
      const partitionIndex = partitionByShapeId.get(cue.shapeId)!;
      const migrated: CueFrame = {
        v: 2,
        id: cue.frame.id,
        type: "cue",
        trackId: cue.frame.trackId,
        stepId: makeMigratedStepId(pageId, globalIndex, partitionIndex),
        stepOrderKey: getMigratedStepOrderKey(globalIndex, partitionIndex),
        action: cue.frame.action,
      };
      updates.push({ shapeId: cue.shapeId, frame: migrated });
    }
  }

  // --- Sub frames: resolve each chain to its head cue (v1 or already-v2 —
  // --- migration preserves frame ids, so heads resolve across formats).
  const cueFrameIds = new Set<string>();
  for (const cue of v1Cues) cueFrameIds.add(cue.frame.id);
  for (const { frame } of existingV2Frames) {
    if (frame.type === "cue") cueFrameIds.add(frame.id);
  }

  const subByFrameId = new Map<
    string,
    { shapeId: string; frame: LegacySubFrame }[]
  >();
  const subsByPrev = new Map<
    string,
    { shapeId: string; frame: LegacySubFrame }[]
  >();
  for (const sub of v1Subs) {
    const byId = subByFrameId.get(sub.frame.id) ?? [];
    byId.push(sub);
    subByFrameId.set(sub.frame.id, byId);
    const byPrev = subsByPrev.get(sub.frame.prevFrameId) ?? [];
    byPrev.push(sub);
    subsByPrev.set(sub.frame.prevFrameId, byPrev);
    if (byPrev.length > 1) {
      // Forked chain: v1 derivation silently dropped all but one fork.
      // Tolerant migration keeps every fork as a batch member.
      const existing = diagnostics.find(
        (d) =>
          d.type === "forked-sub-chain" &&
          d.prevFrameId === sub.frame.prevFrameId,
      );
      if (existing && existing.type === "forked-sub-chain") {
        existing.shapeIds = byPrev.map((s) => s.shapeId);
      } else {
        diagnostics.push({
          type: "forked-sub-chain",
          prevFrameId: sub.frame.prevFrameId,
          shapeIds: byPrev.map((s) => s.shapeId),
        });
      }
    }
  }

  // Already-migrated v2 sub frames: chains may anchor at them (their
  // predecessor was persisted before an interruption), and their order
  // keys reserve migration-chain indices so a resumed run assigns the
  // remaining sub frames exactly the keys a complete run would have.
  const existingSubByFrameId = new Map<string, SubFrame>();
  const existingSubKeysByCue = new Map<string, Set<string>>();
  for (const { frame } of existingV2Frames) {
    if (frame.type !== "sub") continue;
    if (!existingSubByFrameId.has(frame.id)) {
      existingSubByFrameId.set(frame.id, frame);
    }
    const keys = existingSubKeysByCue.get(frame.cueFrameId) ?? new Set();
    keys.add(frame.orderKey);
    existingSubKeysByCue.set(frame.cueFrameId, keys);
  }

  // Reverse-map persisted v2 sub keys to their migration-chain indices.
  // A complete run assigns index = position in the chain, so a persisted
  // sub's index IS its chain position; remaining v1 subs reconstruct
  // their positions relative to these anchors (review finding 7 —
  // arbitrary persisted subsets, not just prefixes).
  const totalSubBound = v1Subs.length + existingSubByFrameId.size + 1;
  const chainIndexByKey = new Map<string, number>();
  for (let index = 0; index < totalSubBound; index++) {
    chainIndexByKey.set(getMigratedSubFrameOrderKey(index), index);
  }

  // Resolve each sub frame's batch and minimum chain index, with cycle
  // protection. minIndex is the frame's exact chain position when the
  // chain is well formed: hops over remaining v1 predecessors add 1 each,
  // and an already-migrated v2 predecessor contributes its persisted
  // index + 1.
  interface Resolved {
    cueFrameId: string;
    minIndex: number;
    dangling: boolean;
  }
  const resolveMemo = new Map<string, Resolved>();
  const resolvingShapeIds = new Set<string>();
  const resolveEntry = (entry: {
    shapeId: string;
    frame: LegacySubFrame;
  }): Resolved => {
    const memoized = resolveMemo.get(entry.shapeId);
    if (memoized != null) {
      return memoized;
    }
    if (resolvingShapeIds.has(entry.shapeId)) {
      // Cycle: treat as dangling at the point of the cycle.
      return {
        cueFrameId: entry.frame.prevFrameId,
        minIndex: 0,
        dangling: true,
      };
    }
    resolvingShapeIds.add(entry.shapeId);
    const prev = entry.frame.prevFrameId;
    let result: Resolved;
    if (cueFrameIds.has(prev)) {
      result = { cueFrameId: prev, minIndex: 0, dangling: false };
    } else {
      const anchor = existingSubByFrameId.get(prev);
      if (anchor != null) {
        // The predecessor is an already-migrated v2 sub frame: the batch
        // is its batch, and this frame's position follows the anchor's
        // persisted chain index (unknown/interactive keys reserve no
        // position and contribute no minimum).
        const anchorIndex = chainIndexByKey.get(anchor.orderKey);
        result = {
          cueFrameId: anchor.cueFrameId,
          minIndex: anchorIndex != null ? anchorIndex + 1 : 0,
          dangling: false,
        };
      } else {
        const prevSubs = subByFrameId.get(prev);
        if (prevSubs == null || prevSubs.length === 0) {
          // Chain hits a frame id that doesn't exist: dangling. Keep the
          // deepest known missing id as the (dangling) cueFrameId so the
          // state stays representable and reattachable.
          result = { cueFrameId: prev, minIndex: 0, dangling: true };
        } else {
          // Deterministic choice among duplicate sub frame ids.
          const prevEntry = [...prevSubs].sort((a, b) =>
            a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0,
          )[0];
          const r = resolveEntry(prevEntry);
          result = {
            cueFrameId: r.cueFrameId,
            minIndex: r.minIndex + 1,
            dangling: r.dangling,
          };
        }
      }
    }
    resolvingShapeIds.delete(entry.shapeId);
    resolveMemo.set(entry.shapeId, result);
    return result;
  };

  interface ResolvedSub {
    shapeId: string;
    frame: LegacySubFrame;
    cueFrameId: string;
    minIndex: number;
    dangling: boolean;
  }
  const resolved: ResolvedSub[] = v1Subs.map((sub) => {
    const head = resolveEntry(sub);
    return { ...sub, ...head };
  });

  // Batch order: chain depth, then frame id, then shape id — deterministic
  // and preserving v1 chain order for well-formed chains.
  const byBatch = new Map<string, ResolvedSub[]>();
  for (const sub of resolved) {
    const list = byBatch.get(sub.cueFrameId) ?? [];
    list.push(sub);
    byBatch.set(sub.cueFrameId, list);
  }
  for (const [cueFrameId, list] of byBatch) {
    list.sort((a, b) => {
      if (a.minIndex !== b.minIndex) return a.minIndex - b.minIndex;
      if (a.frame.id !== b.frame.id) return a.frame.id < b.frame.id ? -1 : 1;
      return a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0;
    });
    // Reserve the chain indices already persisted by an interrupted run so
    // the remaining sub frames land on exactly the keys a complete
    // migration would have assigned (byte-for-byte resume). Persisted keys
    // that are not migration-chain keys (interactively minted) reserve
    // nothing — ordering against them is by key comparison as usual.
    const existingKeys = existingSubKeysByCue.get(cueFrameId);
    const reservedIndices = new Set<number>();
    if (existingKeys != null && existingKeys.size > 0) {
      const scanBound = existingKeys.size + list.length;
      for (
        let index = 0;
        index < scanBound && reservedIndices.size < existingKeys.size;
        index++
      ) {
        if (existingKeys.has(getMigratedSubFrameOrderKey(index))) {
          reservedIndices.add(index);
        }
      }
    }
    let cursor = 0;
    list.forEach((sub) => {
      // Each frame lands at its reconstructed chain position when free
      // (persisted subsets of a complete run resume byte-for-byte);
      // otherwise at the next free index past both its minimum and the
      // previously assigned one.
      let candidate = Math.max(sub.minIndex, cursor);
      while (reservedIndices.has(candidate)) {
        candidate++;
      }
      const orderKey = getMigratedSubFrameOrderKey(candidate);
      cursor = candidate + 1;
      const migrated: SubFrame = {
        v: 2,
        id: sub.frame.id,
        type: "sub",
        cueFrameId,
        orderKey,
        action: sub.frame.action,
      };
      updates.push({ shapeId: sub.shapeId, frame: migrated });
      if (sub.dangling) {
        diagnostics.push({
          type: "dangling-sub-chain",
          shapeId: sub.shapeId,
          missingFrameId: cueFrameId,
        });
        detachedFrames.push({ shapeId: sub.shapeId, frame: sub.frame });
      }
    });
  }

  return { updates, diagnostics, detachedFrames };
}
