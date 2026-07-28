import {
  EASINGS,
  GroupShapeUtil,
  getIndexAbove,
  getIndexBetween,
  getIndicesBetween,
  uniqueId,
} from "tldraw";
import type { Editor, IndexKey, JsonObject, TLShape, TLShapeId } from "tldraw";

export const SYNTHETIC_STEP_PREFIX = "synthstep:";
export const ANIMATION_DATA_FORMAT_VERSION = 2 as const;

export interface FrameActionBase extends JsonObject {
  type: string;
}

export interface ShapeAnimationFrameAction extends FrameActionBase {
  type: "shapeAnimation";
  duration?: number;
  easing?: keyof typeof EASINGS;
}

export interface CameraZoomFrameAction extends FrameActionBase {
  type: "cameraZoom";
  inset?: number;
  duration?: number;
  easing?: keyof typeof EASINGS;
}

export type FrameAction = ShapeAnimationFrameAction | CameraZoomFrameAction;

export interface FrameBase {
  v: typeof ANIMATION_DATA_FORMAT_VERSION;
  id: string;
  type: string;
  action: FrameAction;
}

export interface CueFrame<
  T extends FrameAction = FrameAction,
> extends FrameBase {
  type: "cue";
  trackId: string;
  stepId: string;
  stepOrderKey: string;
  action: T;
}

export interface SubFrame<
  T extends FrameAction = FrameAction,
> extends FrameBase {
  type: "sub";
  cueFrameId: string;
  orderKey: string;
  action: T;
}

export type Frame<T extends FrameAction = FrameAction> =
  | CueFrame<T>
  | SubFrame<T>;

export interface FrameRecord<T extends FrameAction = FrameAction> {
  shapeId: TLShapeId;
  frame: Frame<T>;
}

export interface FrameData {
  frameId: string;
  shapeId: TLShapeId;
  action: FrameAction;
}

export interface BatchData {
  trackId: string;
  frames: FrameData[];
}

export interface StepData {
  id: string;
  batches: BatchData[];
  synthetic?: {
    reason: "same-track-split";
    sourceStepId: string;
  };
}

export type TimelineDiagnostic =
  | {
      type: "step-key-divergence";
      stepId: string;
      shapeIds: TLShapeId[];
    }
  | {
      type: "same-track-split";
      stepId: string;
      trackId: string;
      shapeIds: TLShapeId[];
    }
  | {
      type: "detached-sub-frame";
      shapeId: TLShapeId;
      cueFrameId: string;
    }
  | {
      type: "duplicate-frame-id";
      frameId: string;
      shapeIds: TLShapeId[];
    }
  | { type: "invalid-frame"; shapeId: TLShapeId };

export interface TimelineDoc {
  version: 1;
  steps: StepData[];
  detachedFrames: FrameData[];
  diagnostics: TimelineDiagnostic[];
}

export interface FrameParseResult {
  frame?: Frame;
  diagnostic?: Extract<TimelineDiagnostic, { type: "invalid-frame" }>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isOptionalEasing(
  value: unknown,
): value is keyof typeof EASINGS | undefined {
  return value === undefined || (typeof value === "string" && value in EASINGS);
}

export function isFrameAction(value: unknown): value is FrameAction {
  if (!isJsonObject(value) || typeof value.type !== "string") return false;
  if (!isOptionalNumber(value.duration) || !isOptionalEasing(value.easing)) {
    return false;
  }
  if (value.type === "shapeAnimation") return true;
  return value.type === "cameraZoom" && isOptionalNumber(value.inset);
}

export function parseFrameObject(
  value: unknown,
  options: { allowReservedStepId?: boolean } = {},
): Frame | undefined {
  if (
    !isJsonObject(value) ||
    value.v !== ANIMATION_DATA_FORMAT_VERSION ||
    typeof value.id !== "string" ||
    !isFrameAction(value.action)
  ) {
    return undefined;
  }

  if (
    value.type === "cue" &&
    typeof value.trackId === "string" &&
    typeof value.stepId === "string" &&
    (options.allowReservedStepId ||
      !value.stepId.startsWith(SYNTHETIC_STEP_PREFIX)) &&
    typeof value.stepOrderKey === "string"
  ) {
    return {
      v: 2,
      id: value.id,
      type: "cue",
      trackId: value.trackId,
      stepId: value.stepId,
      stepOrderKey: value.stepOrderKey,
      action: value.action,
    };
  }

  if (
    value.type === "sub" &&
    typeof value.cueFrameId === "string" &&
    typeof value.orderKey === "string"
  ) {
    return {
      v: 2,
      id: value.id,
      type: "sub",
      cueFrameId: value.cueFrameId,
      orderKey: value.orderKey,
      action: value.action,
    };
  }

  return undefined;
}

export function parseFrame(shape: TLShape): FrameParseResult {
  if (!("frame" in shape.meta)) return {};
  const frame = parseFrameObject(shape.meta.frame);
  if (frame) return { frame };

  const value = shape.meta.frame;
  if (
    isJsonObject(value) &&
    value.v === undefined &&
    (value.type === "cue" || value.type === "sub")
  ) {
    return {};
  }

  const environment = (import.meta as ImportMeta & { env?: { DEV?: boolean } })
    .env;
  if (environment?.DEV) {
    console.warn("Uninterpretable animation data", { shapeId: shape.id });
  }
  return {
    diagnostic: { type: "invalid-frame", shapeId: shape.id },
  };
}

export function cueFrameToJsonObject(frame: CueFrame): JsonObject {
  const { v, id, type, trackId, stepId, stepOrderKey, action } = frame;
  return { v, id, type, trackId, stepId, stepOrderKey, action };
}

export function subFrameToJsonObject(frame: SubFrame): JsonObject {
  const { v, id, type, cueFrameId, orderKey, action } = frame;
  return { v, id, type, cueFrameId, orderKey, action };
}

export function frameToJsonObject(frame: Frame): JsonObject {
  return frame.type === "cue"
    ? cueFrameToJsonObject(frame)
    : subFrameToJsonObject(frame);
}

export function jsonObjectToCueFrame(value: unknown): CueFrame {
  const frame = parseFrameObject(value);
  if (frame?.type === "cue") return frame;
  throw new Error(
    `Given input is not a valid CueFrame. ${JSON.stringify(value)}`,
  );
}

export function getFrame(shape: TLShape): Frame | undefined {
  return parseFrame(shape).frame;
}

export function getFrames(shapes: readonly TLShape[]): Frame[] {
  return shapes.map(getFrame).filter((frame) => frame !== undefined);
}

export function getFrameRecords(shapes: readonly TLShape[]): FrameRecord[] {
  return shapes.flatMap((shape) => {
    const frame = getFrame(shape);
    return frame ? [{ shapeId: shape.id, frame }] : [];
  });
}

export function getCueFrame(shape: TLShape): CueFrame | undefined {
  const frame = getFrame(shape);
  return frame?.type === "cue" ? frame : undefined;
}

export function getSubFrame(shape: TLShape): SubFrame | undefined {
  const frame = getFrame(shape);
  return frame?.type === "sub" ? frame : undefined;
}

export function newStepId(): string {
  return uniqueId();
}

export function newTrackId(): string {
  return `track-${Date.now()}-${uniqueId()}`;
}

export function getStepOrderKeyAfter(lastKey?: string): string {
  return getIndexAbove(lastKey as IndexKey | undefined);
}

export function getOrderKeyBetween(
  lowerKey?: string,
  upperKey?: string,
): string {
  return getIndexBetween(
    lowerKey as IndexKey | undefined,
    upperKey as IndexKey | undefined,
  );
}

export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function makeInsertionSpace(
  orderedItems: readonly { id: string; key: string }[],
  insertionIndex: number,
): { updates: { id: string; key: string }[]; insertedKey: string } {
  if (insertionIndex < 0 || insertionIndex > orderedItems.length) {
    throw new RangeError("Insertion index is outside the ordered item list");
  }

  const previous = orderedItems[insertionIndex - 1];
  const next = orderedItems[insertionIndex];
  if (!previous || !next || previous.key !== next.key) {
    return {
      updates: [],
      insertedKey: getIndexBetween(
        previous?.key as IndexKey | undefined,
        next?.key as IndexKey | undefined,
      ),
    };
  }

  const collisionKey = previous.key;
  let runStart = insertionIndex - 1;
  let runEnd = insertionIndex;
  while (runStart > 0 && orderedItems[runStart - 1].key === collisionKey) {
    runStart--;
  }
  while (
    runEnd + 1 < orderedItems.length &&
    orderedItems[runEnd + 1].key === collisionKey
  ) {
    runEnd++;
  }

  const run = orderedItems.slice(runStart, runEnd + 1);
  const keys = getIndicesBetween(
    orderedItems[runStart - 1]?.key as IndexKey | undefined,
    orderedItems[runEnd + 1]?.key as IndexKey | undefined,
    run.length + 1,
  );
  const insertedOffset = insertionIndex - runStart;
  const updates = run.map((item, index) => ({
    id: item.id,
    key: keys[index < insertedOffset ? index : index + 1],
  }));
  return { updates, insertedKey: keys[insertedOffset] };
}

function compareFrameRecords(a: FrameRecord, b: FrameRecord): number {
  return (
    a.frame.id.localeCompare(b.frame.id) || a.shapeId.localeCompare(b.shapeId)
  );
}

function toFrameData(record: FrameRecord): FrameData {
  return {
    frameId: record.frame.id,
    shapeId: record.shapeId,
    action: record.frame.action,
  };
}

function syntheticStepId(sourceStepId: string, cueShapeId: TLShapeId): string {
  return `${SYNTHETIC_STEP_PREFIX}${JSON.stringify([sourceStepId, cueShapeId])}`;
}

export function deriveTimeline(
  records: readonly FrameRecord[],
  initialDiagnostics: readonly TimelineDiagnostic[] = [],
): TimelineDoc {
  const diagnostics: TimelineDiagnostic[] = [...initialDiagnostics];
  const ids = new Map<string, FrameRecord[]>();
  for (const record of records) {
    const group = ids.get(record.frame.id) ?? [];
    group.push(record);
    ids.set(record.frame.id, group);
  }
  for (const [frameId, duplicates] of ids) {
    if (duplicates.length > 1) {
      diagnostics.push({
        type: "duplicate-frame-id",
        frameId,
        shapeIds: duplicates.map((item) => item.shapeId).sort(),
      });
    }
  }

  const cues = records
    .filter(
      (record): record is FrameRecord & { frame: CueFrame } =>
        record.frame.type === "cue",
    )
    .sort(compareFrameRecords);
  const subs = records.filter(
    (record): record is FrameRecord & { frame: SubFrame } =>
      record.frame.type === "sub",
  );

  const representativeCueByFrameId = new Map<string, (typeof cues)[number]>();
  for (const cue of [...cues].sort((a, b) =>
    a.shapeId.localeCompare(b.shapeId),
  )) {
    if (!representativeCueByFrameId.has(cue.frame.id)) {
      representativeCueByFrameId.set(cue.frame.id, cue);
    }
  }

  const subsByCueShapeId = new Map<TLShapeId, typeof subs>();
  const detachedFrames: FrameData[] = [];
  for (const sub of subs) {
    const cue = representativeCueByFrameId.get(sub.frame.cueFrameId);
    if (!cue) {
      detachedFrames.push(toFrameData(sub));
      diagnostics.push({
        type: "detached-sub-frame",
        shapeId: sub.shapeId,
        cueFrameId: sub.frame.cueFrameId,
      });
      continue;
    }
    const group = subsByCueShapeId.get(cue.shapeId) ?? [];
    group.push(sub);
    subsByCueShapeId.set(cue.shapeId, group);
  }

  const stepGroups = new Map<string, typeof cues>();
  for (const cue of cues) {
    const group = stepGroups.get(cue.frame.stepId) ?? [];
    group.push(cue);
    stepGroups.set(cue.frame.stepId, group);
  }

  const orderedGroups = [...stepGroups.entries()]
    .map(([stepId, group]) => {
      group.sort(compareFrameRecords);
      const canonicalKey = group[0].frame.stepOrderKey;
      const divergent = group
        .filter((record) => record.frame.stepOrderKey !== canonicalKey)
        .map((record) => record.shapeId)
        .sort();
      if (divergent.length > 0) {
        diagnostics.push({
          type: "step-key-divergence",
          stepId,
          shapeIds: divergent,
        });
      }
      return { stepId, group, canonicalKey };
    })
    .sort(
      (a, b) =>
        compareOrderKeys(a.canonicalKey, b.canonicalKey) ||
        a.stepId.localeCompare(b.stepId),
    );

  const steps: StepData[] = [];
  for (const { stepId, group } of orderedGroups) {
    const seenTracks = new Map<string, TLShapeId>();
    const batches: BatchData[] = [];
    const syntheticSteps: StepData[] = [];

    for (const cue of group) {
      const subFrames = (subsByCueShapeId.get(cue.shapeId) ?? []).sort(
        (a, b) =>
          compareOrderKeys(a.frame.orderKey, b.frame.orderKey) ||
          a.frame.id.localeCompare(b.frame.id) ||
          a.shapeId.localeCompare(b.shapeId),
      );
      const batch: BatchData = {
        trackId: cue.frame.trackId,
        frames: [toFrameData(cue), ...subFrames.map(toFrameData)],
      };
      const firstShapeId = seenTracks.get(cue.frame.trackId);
      if (firstShapeId === undefined) {
        seenTracks.set(cue.frame.trackId, cue.shapeId);
        batches.push(batch);
      } else {
        diagnostics.push({
          type: "same-track-split",
          stepId,
          trackId: cue.frame.trackId,
          shapeIds: [firstShapeId, cue.shapeId].sort(),
        });
        syntheticSteps.push({
          id: syntheticStepId(stepId, cue.shapeId),
          batches: [batch],
          synthetic: { reason: "same-track-split", sourceStepId: stepId },
        });
      }
    }

    steps.push({ id: stepId, batches }, ...syntheticSteps);
  }

  detachedFrames.sort((a, b) => a.shapeId.localeCompare(b.shapeId));
  diagnostics.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  return { version: 1, steps, detachedFrames, diagnostics };
}

export function getLeafShapes(
  editor: Editor,
  ancestorShape: TLShape,
): TLShape[] {
  if (ancestorShape.type !== GroupShapeUtil.type) return [ancestorShape];
  return editor
    .getSortedChildIdsForParent(ancestorShape.id)
    .map((id) => editor.getShape(id))
    .filter((shape): shape is TLShape => shape !== undefined)
    .flatMap((shape) => getLeafShapes(editor, shape));
}
