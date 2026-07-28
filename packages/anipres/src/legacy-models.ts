import { generateKeyBetween } from "fractional-indexing";
import type {
  Editor,
  JsonObject,
  TLPageId,
  TLShape,
  TLShapeId,
  TLShapePartial,
} from "tldraw";
import {
  deriveTimeline,
  frameToJsonObject,
  getFrameRecords,
  isFrameAction,
  parseFrame,
  type CueFrame,
  type Frame,
  type FrameAction,
  type FrameRecord,
  type SubFrame,
  type TimelineDiagnostic,
  type TimelineDoc,
} from "./models";

export interface LegacyFrameBase {
  id: string;
  type: string;
  action: FrameAction;
}

export interface LegacyCueFrame extends LegacyFrameBase {
  type: "cue";
  globalIndex: number;
  trackId: string;
}

export interface LegacySubFrame extends LegacyFrameBase {
  type: "sub";
  prevFrameId: string;
}

export type LegacyFrame = LegacyCueFrame | LegacySubFrame;

export interface LegacyFrameRecord {
  shapeId: TLShapeId;
  frame: LegacyFrame;
}

export type MigrationDiagnostic =
  | Extract<TimelineDiagnostic, { type: "invalid-frame" }>
  | {
      type: "same-track-partition";
      globalIndex: number;
      trackId: string;
      shapeIds: TLShapeId[];
    }
  | {
      type: "forked-chain";
      prevFrameId: string;
      shapeIds: TLShapeId[];
    }
  | {
      type: "detached-legacy-frame";
      shapeId: TLShapeId;
      prevFrameId: string;
    }
  | {
      type: "contradictory-migrated-partition";
      globalIndex: number;
      partitionIndex: number;
      trackId: string;
      shapeIds: TLShapeId[];
    };

export interface ShapeFrameUpdate {
  id: TLShapeId;
  type: string;
  meta: JsonObject;
}

export interface MigrationResult {
  updates: ShapeFrameUpdate[];
  diagnostics: MigrationDiagnostic[];
  detachedFrames: { shapeId: TLShapeId; frame: LegacyFrame }[];
}

interface PreparedAnimationData {
  records: FrameRecord[];
  invalidDiagnostics: Extract<TimelineDiagnostic, { type: "invalid-frame" }>[];
  migration: MigrationResult;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLegacyFrameObject(
  value: unknown,
): LegacyFrame | undefined {
  if (
    !isJsonObject(value) ||
    value.v !== undefined ||
    typeof value.id !== "string" ||
    !isFrameAction(value.action)
  ) {
    return undefined;
  }
  if (
    value.type === "cue" &&
    typeof value.globalIndex === "number" &&
    Number.isFinite(value.globalIndex) &&
    Number.isInteger(value.globalIndex) &&
    typeof value.trackId === "string"
  ) {
    return {
      id: value.id,
      type: "cue",
      globalIndex: value.globalIndex,
      trackId: value.trackId,
      action: value.action,
    };
  }
  if (value.type === "sub" && typeof value.prevFrameId === "string") {
    return {
      id: value.id,
      type: "sub",
      prevFrameId: value.prevFrameId,
      action: value.action,
    };
  }
  return undefined;
}

export function getLegacyFrame(shape: TLShape): LegacyFrame | undefined {
  return parseLegacyFrameObject(shape.meta.frame);
}

export function parseMigratedStepId(
  stepId: string,
): { pageId: string; globalIndex: number; partitionIndex: number } | undefined {
  const match = /^v1step:(.*):(-?\d+):(\d+)$/.exec(stepId);
  if (!match) return undefined;
  const globalIndex = Number(match[2]);
  const partitionIndex = Number(match[3]);
  if (
    !Number.isSafeInteger(globalIndex) ||
    !Number.isSafeInteger(partitionIndex)
  ) {
    return undefined;
  }
  return { pageId: match[1], globalIndex, partitionIndex };
}

const migratedCoordinateKeyCache = new Map<number, string>();

function getCoordinateKey(globalIndex: number): string {
  const cached = migratedCoordinateKeyCache.get(globalIndex);
  if (cached) return cached;

  const zero = generateKeyBetween(null, null);
  migratedCoordinateKeyCache.set(0, zero);
  if (globalIndex > 0) {
    let key = zero;
    for (let index = 1; index <= globalIndex; index++) {
      key =
        migratedCoordinateKeyCache.get(index) ?? generateKeyBetween(key, null);
      migratedCoordinateKeyCache.set(index, key);
    }
    return key;
  }

  let key = zero;
  for (let index = -1; index >= globalIndex; index--) {
    key =
      migratedCoordinateKeyCache.get(index) ?? generateKeyBetween(null, key);
    migratedCoordinateKeyCache.set(index, key);
  }
  return key;
}

export function getMigratedStepOrderKey(
  globalIndex: number,
  partitionIndex: number,
): string {
  if (!Number.isInteger(globalIndex) || !Number.isInteger(partitionIndex)) {
    throw new TypeError("Migration coordinates must be integers");
  }
  if (partitionIndex < 0) {
    throw new RangeError("Migration partition must not be negative");
  }
  let key = getCoordinateKey(globalIndex);
  if (partitionIndex === 0) return key;
  const upper = getCoordinateKey(globalIndex + 1);
  for (let index = 0; index < partitionIndex; index++) {
    key = generateKeyBetween(key, upper);
  }
  return key;
}

export function getMigratedSubFrameOrderKey(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError("Sub-frame migration index must not be negative");
  }
  let key = generateKeyBetween(null, null);
  for (let current = 0; current < index; current++) {
    key = generateKeyBetween(key, null);
  }
  return key;
}

function compareLegacyRecords(
  a: LegacyFrameRecord,
  b: LegacyFrameRecord,
): number {
  return (
    a.frame.id.localeCompare(b.frame.id) || a.shapeId.localeCompare(b.shapeId)
  );
}

function makeUpdate(shape: TLShape, frame: Frame): ShapeFrameUpdate {
  return {
    id: shape.id,
    type: shape.type,
    meta: { ...shape.meta, frame: frameToJsonObject(frame) },
  };
}

export function migrateLegacyFrames(
  shapes: readonly TLShape[],
  pageId: TLPageId | string,
): MigrationResult {
  return prepareAnimationData(shapes, pageId).migration;
}

function prepareAnimationData(
  shapes: readonly TLShape[],
  pageId: TLPageId | string,
): PreparedAnimationData {
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const legacyRecords: LegacyFrameRecord[] = [];
  const v2Records = getFrameRecords(shapes);
  const invalidDiagnostics: Extract<
    TimelineDiagnostic,
    { type: "invalid-frame" }
  >[] = [];

  for (const shape of shapes) {
    const legacyFrame = getLegacyFrame(shape);
    if (legacyFrame) {
      legacyRecords.push({ shapeId: shape.id, frame: legacyFrame });
      continue;
    }
    const parsed = parseFrame(shape);
    if (parsed.diagnostic) {
      invalidDiagnostics.push(parsed.diagnostic);
    } else if (!parsed.frame && "frame" in shape.meta) {
      invalidDiagnostics.push({ type: "invalid-frame", shapeId: shape.id });
    }
  }

  const diagnostics: MigrationDiagnostic[] = [...invalidDiagnostics];
  const updates: ShapeFrameUpdate[] = [];
  const convertedRecords: FrameRecord[] = [];
  const legacyCues = legacyRecords.filter(
    (record): record is LegacyFrameRecord & { frame: LegacyCueFrame } =>
      record.frame.type === "cue",
  );
  const legacySubs = legacyRecords.filter(
    (record): record is LegacyFrameRecord & { frame: LegacySubFrame } =>
      record.frame.type === "sub",
  );

  type ExistingCue = FrameRecord & {
    frame: CueFrame;
    coordinates: ReturnType<typeof parseMigratedStepId> & {};
  };
  const existingMigratedCues = v2Records.flatMap((record): ExistingCue[] => {
    if (record.frame.type !== "cue") return [];
    const coordinates = parseMigratedStepId(record.frame.stepId);
    if (!coordinates || coordinates.pageId !== pageId) return [];
    return [{ ...record, frame: record.frame, coordinates }];
  });

  const globalIndexes = new Set<number>([
    ...legacyCues.map((record) => record.frame.globalIndex),
    ...existingMigratedCues.map((record) => record.coordinates.globalIndex),
  ]);
  for (const globalIndex of [...globalIndexes].sort((a, b) => a - b)) {
    const rawGroup = legacyCues
      .filter((record) => record.frame.globalIndex === globalIndex)
      .sort(compareLegacyRecords);
    const existingGroup = existingMigratedCues.filter(
      (record) => record.coordinates.globalIndex === globalIndex,
    );
    const occupiedTracks = new Map<number, Map<string, TLShapeId[]>>();
    for (const existing of existingGroup) {
      const partitionIndex = existing.coordinates.partitionIndex;
      const tracks = occupiedTracks.get(partitionIndex) ?? new Map();
      const shapeIds = tracks.get(existing.frame.trackId) ?? [];
      shapeIds.push(existing.shapeId);
      tracks.set(existing.frame.trackId, shapeIds);
      occupiedTracks.set(partitionIndex, tracks);
    }
    for (const [partitionIndex, tracks] of occupiedTracks) {
      for (const [trackId, shapeIds] of tracks) {
        if (shapeIds.length > 1) {
          diagnostics.push({
            type: "contradictory-migrated-partition",
            globalIndex,
            partitionIndex,
            trackId,
            shapeIds: [...shapeIds].sort(),
          });
        }
      }
    }

    const assignedByTrack = new Map<string, TLShapeId[]>();
    for (const record of rawGroup) {
      let partitionIndex = 0;
      while (occupiedTracks.get(partitionIndex)?.has(record.frame.trackId)) {
        partitionIndex++;
      }
      const tracks = occupiedTracks.get(partitionIndex) ?? new Map();
      tracks.set(record.frame.trackId, [record.shapeId]);
      occupiedTracks.set(partitionIndex, tracks);

      const trackShapes = assignedByTrack.get(record.frame.trackId) ?? [];
      trackShapes.push(record.shapeId);
      assignedByTrack.set(record.frame.trackId, trackShapes);

      const frame: CueFrame = {
        v: 2,
        id: record.frame.id,
        type: "cue",
        trackId: record.frame.trackId,
        stepId: `v1step:${pageId}:${globalIndex}:${partitionIndex}`,
        stepOrderKey: getMigratedStepOrderKey(globalIndex, partitionIndex),
        action: record.frame.action,
      };
      convertedRecords.push({ shapeId: record.shapeId, frame });
      updates.push(makeUpdate(shapeById.get(record.shapeId)!, frame));
    }
    for (const [trackId, shapeIds] of assignedByTrack) {
      const existingCount = existingGroup.filter(
        (record) => record.frame.trackId === trackId,
      ).length;
      if (shapeIds.length + existingCount > 1) {
        diagnostics.push({
          type: "same-track-partition",
          globalIndex,
          trackId,
          shapeIds: [
            ...existingGroup
              .filter((record) => record.frame.trackId === trackId)
              .map((record) => record.shapeId),
            ...shapeIds,
          ].sort(),
        });
      }
    }
  }

  const candidatesByFrameId = new Map<
    string,
    (LegacyFrameRecord | FrameRecord)[]
  >();
  for (const record of [...legacyRecords, ...v2Records, ...convertedRecords]) {
    const candidates = candidatesByFrameId.get(record.frame.id) ?? [];
    candidates.push(record);
    candidatesByFrameId.set(record.frame.id, candidates);
  }
  for (const candidates of candidatesByFrameId.values()) {
    candidates.sort((a, b) => a.shapeId.localeCompare(b.shapeId));
  }

  const forks = new Map<string, LegacyFrameRecord[]>();
  for (const sub of legacySubs) {
    const group = forks.get(sub.frame.prevFrameId) ?? [];
    group.push(sub);
    forks.set(sub.frame.prevFrameId, group);
  }
  for (const [prevFrameId, group] of forks) {
    if (group.length > 1) {
      diagnostics.push({
        type: "forked-chain",
        prevFrameId,
        shapeIds: group.map((record) => record.shapeId).sort(),
      });
    }
  }

  const existingV2Subs = v2Records.filter(
    (record): record is FrameRecord & { frame: SubFrame } =>
      record.frame.type === "sub",
  );
  const existingSubIndexByShapeId = new Map<TLShapeId, number>();
  const reservedSubIndexesByCue = new Map<string, Set<number>>();
  const existingSubsByCue = new Map<string, typeof existingV2Subs>();
  for (const record of existingV2Subs) {
    const group = existingSubsByCue.get(record.frame.cueFrameId) ?? [];
    group.push(record);
    existingSubsByCue.set(record.frame.cueFrameId, group);
  }
  const maximumReconstructedBatchSize =
    legacySubs.length + existingV2Subs.length;
  const migratedSubIndexByKey = new Map(
    Array.from({ length: maximumReconstructedBatchSize }, (_, index) => [
      getMigratedSubFrameOrderKey(index),
      index,
    ]),
  );
  for (const [cueFrameId, group] of existingSubsByCue) {
    group.sort(
      (a, b) =>
        a.frame.orderKey.localeCompare(b.frame.orderKey) ||
        a.frame.id.localeCompare(b.frame.id) ||
        a.shapeId.localeCompare(b.shapeId),
    );
    const reserved = new Set<number>();
    for (const record of group) {
      const migratedIndex = migratedSubIndexByKey.get(record.frame.orderKey);
      if (migratedIndex !== undefined && !reserved.has(migratedIndex)) {
        existingSubIndexByShapeId.set(record.shapeId, migratedIndex);
        reserved.add(migratedIndex);
      }
    }
    for (const record of group) {
      if (existingSubIndexByShapeId.has(record.shapeId)) continue;
      let index = 0;
      while (reserved.has(index)) index++;
      existingSubIndexByShapeId.set(record.shapeId, index);
      reserved.add(index);
    }
    reservedSubIndexesByCue.set(cueFrameId, reserved);
  }

  const cueByLegacySubShape = new Map<TLShapeId, string | undefined>();
  const minimumIndexByLegacySubShape = new Map<TLShapeId, number>();
  const resolveCue = (
    record: LegacyFrameRecord & { frame: LegacySubFrame },
    visiting: Set<TLShapeId>,
  ): { cueFrameId?: string; minimumIndex: number } => {
    if (cueByLegacySubShape.has(record.shapeId)) {
      return {
        cueFrameId: cueByLegacySubShape.get(record.shapeId),
        minimumIndex: minimumIndexByLegacySubShape.get(record.shapeId) ?? 0,
      };
    }
    if (visiting.has(record.shapeId)) return { minimumIndex: 0 };
    visiting.add(record.shapeId);
    const predecessor = candidatesByFrameId.get(record.frame.prevFrameId)?.[0];
    let result: { cueFrameId?: string; minimumIndex: number };
    if (!predecessor) {
      result = { minimumIndex: 0 };
    } else if ("v" in predecessor.frame) {
      result =
        predecessor.frame.type === "cue"
          ? { cueFrameId: predecessor.frame.id, minimumIndex: 0 }
          : {
              cueFrameId: predecessor.frame.cueFrameId,
              minimumIndex:
                (existingSubIndexByShapeId.get(predecessor.shapeId) ?? 0) + 1,
            };
    } else if (predecessor.frame.type === "cue") {
      result = { cueFrameId: predecessor.frame.id, minimumIndex: 0 };
    } else {
      const parent = resolveCue(
        predecessor as LegacyFrameRecord & { frame: LegacySubFrame },
        visiting,
      );
      result = {
        cueFrameId: parent.cueFrameId,
        minimumIndex: parent.minimumIndex + 1,
      };
    }
    visiting.delete(record.shapeId);
    cueByLegacySubShape.set(record.shapeId, result.cueFrameId);
    minimumIndexByLegacySubShape.set(record.shapeId, result.minimumIndex);
    return result;
  };

  const detachedFrames: (LegacyFrameRecord & { frame: LegacySubFrame })[] = [];
  const subsByCue = new Map<string, typeof legacySubs>();
  for (const sub of legacySubs) {
    const { cueFrameId } = resolveCue(sub, new Set());
    if (!cueFrameId) {
      detachedFrames.push(sub);
      diagnostics.push({
        type: "detached-legacy-frame",
        shapeId: sub.shapeId,
        prevFrameId: sub.frame.prevFrameId,
      });
      continue;
    }
    const group = subsByCue.get(cueFrameId) ?? [];
    group.push(sub);
    subsByCue.set(cueFrameId, group);
  }

  for (const [cueFrameId, group] of subsByCue) {
    group.sort(
      (a, b) =>
        (minimumIndexByLegacySubShape.get(a.shapeId) ?? 0) -
          (minimumIndexByLegacySubShape.get(b.shapeId) ?? 0) ||
        compareLegacyRecords(a, b),
    );
    const reserved = new Set(reservedSubIndexesByCue.get(cueFrameId) ?? []);
    group.forEach((record) => {
      let index = minimumIndexByLegacySubShape.get(record.shapeId) ?? 0;
      while (reserved.has(index)) index++;
      reserved.add(index);
      const frame: SubFrame = {
        v: 2,
        id: record.frame.id,
        type: "sub",
        cueFrameId,
        orderKey: getMigratedSubFrameOrderKey(index),
        action: record.frame.action,
      };
      convertedRecords.push({ shapeId: record.shapeId, frame });
      updates.push(makeUpdate(shapeById.get(record.shapeId)!, frame));
    });
  }

  detachedFrames.sort(compareLegacyRecords);
  detachedFrames.forEach((record, index) => {
    const frame: SubFrame = {
      v: 2,
      id: record.frame.id,
      type: "sub",
      cueFrameId: record.frame.prevFrameId,
      orderKey: getMigratedSubFrameOrderKey(index),
      action: record.frame.action,
    };
    convertedRecords.push({ shapeId: record.shapeId, frame });
    updates.push(makeUpdate(shapeById.get(record.shapeId)!, frame));
  });

  updates.sort((a, b) => a.id.localeCompare(b.id));
  return {
    records: [...v2Records, ...convertedRecords],
    invalidDiagnostics,
    migration: { updates, diagnostics, detachedFrames },
  };
}

export function deriveTimelineFromShapes(
  shapes: readonly TLShape[],
  pageId: TLPageId | string,
): TimelineDoc {
  const prepared = prepareAnimationData(shapes, pageId);
  return deriveTimeline(prepared.records, prepared.invalidDiagnostics);
}

export function migrateAnimationDataInEditor(editor: Editor): MigrationResult {
  const shapes = editor.store
    .allRecords()
    .filter((record): record is TLShape => record.typeName === "shape");
  const shapesById = new Map(shapes.map((shape) => [shape.id, shape]));
  const shapesByPage = new Map<TLPageId, TLShape[]>();
  const pageIds = new Set(editor.getPages().map((page) => page.id));

  for (const shape of shapes) {
    let parentId = shape.parentId;
    const visited = new Set<string>();
    while (!pageIds.has(parentId as TLPageId)) {
      if (visited.has(parentId)) break;
      visited.add(parentId);
      const parent = shapesById.get(parentId as TLShapeId);
      if (!parent) break;
      parentId = parent.parentId;
    }
    if (!pageIds.has(parentId as TLPageId)) continue;
    const pageId = parentId as TLPageId;
    const group = shapesByPage.get(pageId) ?? [];
    group.push(shape);
    shapesByPage.set(pageId, group);
  }

  const result: MigrationResult = {
    updates: [],
    diagnostics: [],
    detachedFrames: [],
  };
  for (const [pageId, pageShapes] of shapesByPage) {
    const pageResult = migrateLegacyFrames(pageShapes, pageId);
    result.updates.push(...pageResult.updates);
    result.diagnostics.push(...pageResult.diagnostics);
    result.detachedFrames.push(...pageResult.detachedFrames);
  }

  if (result.updates.length > 0) {
    editor.run(() => editor.updateShapes(result.updates as TLShapePartial[]), {
      history: "ignore",
    });
  }
  return result;
}
