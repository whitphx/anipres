import { getIndexAbove, getIndexBetween, uniqueId } from "tldraw";
import type { TLContent, TLShape, TLShapeId } from "tldraw";
import {
  frameToJsonObject,
  getFrameRecords,
  newStepId,
  newTrackId,
  parseFrameObject,
  SYNTHETIC_STEP_PREFIX,
  type CueFrame,
  type Frame,
} from "./models";

export interface ContentPreprocessDiagnostic {
  type: "ambiguous-cue-reference";
  cueFrameId: string;
  sourceShapeIds: TLShapeId[];
  subShapeId: TLShapeId;
}

export interface AnimationContentPreprocessOptions {
  createFrameId?: () => string;
  createStepId?: () => string;
  createTrackId?: () => string;
}

export function preprocessAnimationContent(
  content: TLContent,
  existingShapes: readonly TLShape[],
  options: AnimationContentPreprocessOptions = {},
): ContentPreprocessDiagnostic[] {
  const createFrameId = options.createFrameId ?? uniqueId;
  const createStepId = options.createStepId ?? newStepId;
  const createTrackId = options.createTrackId ?? newTrackId;
  const existingRecords = getFrameRecords(existingShapes);
  const existingFrameIds = new Set(
    existingRecords.map((record) => record.frame.id),
  );
  const existingStepIds = new Set(
    existingRecords.flatMap((record) =>
      record.frame.type === "cue" ? [record.frame.stepId] : [],
    ),
  );
  const existingTrackIds = new Set(
    existingRecords.flatMap((record) =>
      record.frame.type === "cue" ? [record.frame.trackId] : [],
    ),
  );
  const frames = content.shapes.flatMap((shape) => {
    const frame = parseFrameObject(shape.meta.frame, {
      allowReservedStepId: true,
    });
    return frame ? [{ shape, frame }] : [];
  });
  const frameIdCounts = new Map<string, number>();
  for (const { frame } of frames) {
    frameIdCounts.set(frame.id, (frameIdCounts.get(frame.id) ?? 0) + 1);
  }

  const newFrameIdBySourceShapeId = new Map<TLShapeId, string>();
  for (const { shape, frame } of [...frames].sort((a, b) =>
    a.shape.id.localeCompare(b.shape.id),
  )) {
    if (
      existingFrameIds.has(frame.id) ||
      (frameIdCounts.get(frame.id) ?? 0) > 1
    ) {
      newFrameIdBySourceShapeId.set(shape.id, createFrameId());
    }
  }

  const cues = frames.filter(
    (item): item is { shape: TLShape; frame: CueFrame } =>
      item.frame.type === "cue",
  );
  const copiedSourceShapeIds = new Set(content.shapes.map((shape) => shape.id));
  const withinDocument = existingShapes.some((shape) =>
    copiedSourceShapeIds.has(shape.id),
  );
  const stepIdsToRemap = new Set(
    cues
      .filter(
        ({ frame }) =>
          withinDocument ||
          existingStepIds.has(frame.stepId) ||
          frame.stepId.startsWith(SYNTHETIC_STEP_PREFIX),
      )
      .map(({ frame }) => frame.stepId),
  );
  const trackIdsToRemap = new Set(
    cues
      .filter(
        ({ frame }) => withinDocument || existingTrackIds.has(frame.trackId),
      )
      .map(({ frame }) => frame.trackId),
  );
  const stepIdMap = new Map<string, string>();
  const trackIdMap = new Map<string, string>();
  for (const stepId of [...stepIdsToRemap].sort()) {
    stepIdMap.set(stepId, createStepId());
  }
  for (const trackId of [...trackIdsToRemap].sort()) {
    trackIdMap.set(trackId, createTrackId());
  }

  const orderedExistingSteps = existingRecords
    .filter(
      (record): record is typeof record & { frame: CueFrame } =>
        record.frame.type === "cue",
    )
    .sort(
      (a, b) =>
        a.frame.stepOrderKey.localeCompare(b.frame.stepOrderKey) ||
        a.frame.stepId.localeCompare(b.frame.stepId),
    );
  const copiedStepOrderKey = new Map<string, string>();
  for (const stepId of [...stepIdsToRemap].sort()) {
    const originalIndex = orderedExistingSteps.findIndex(
      (record) => record.frame.stepId === stepId,
    );
    const original = orderedExistingSteps[originalIndex]?.frame;
    const next = orderedExistingSteps
      .slice(originalIndex + 1)
      .find((record) => record.frame.stepId !== stepId)?.frame;
    copiedStepOrderKey.set(
      stepId,
      original
        ? getIndexBetween(
            original.stepOrderKey as never,
            next?.stepOrderKey as never,
          )
        : getIndexAbove(
            orderedExistingSteps.at(-1)?.frame.stepOrderKey as never,
          ),
    );
  }

  const cueSourcesByFrameId = new Map<string, typeof cues>();
  for (const cue of cues) {
    const group = cueSourcesByFrameId.get(cue.frame.id) ?? [];
    group.push(cue);
    cueSourcesByFrameId.set(cue.frame.id, group);
  }
  for (const group of cueSourcesByFrameId.values()) {
    group.sort((a, b) => a.shape.id.localeCompare(b.shape.id));
  }

  const diagnostics: ContentPreprocessDiagnostic[] = [];
  const frameByShapeId = new Map<TLShapeId, Frame>();
  for (const { shape, frame } of frames) {
    if (frame.type === "cue") {
      const remappedStepId = stepIdMap.get(frame.stepId);
      frameByShapeId.set(shape.id, {
        ...frame,
        id: newFrameIdBySourceShapeId.get(shape.id) ?? frame.id,
        stepId: remappedStepId ?? frame.stepId,
        stepOrderKey: remappedStepId
          ? (copiedStepOrderKey.get(frame.stepId) ?? frame.stepOrderKey)
          : frame.stepOrderKey,
        trackId: trackIdMap.get(frame.trackId) ?? frame.trackId,
      });
      continue;
    }
    const sourceCues = cueSourcesByFrameId.get(frame.cueFrameId) ?? [];
    const representative = sourceCues[0];
    if (sourceCues.length > 1) {
      diagnostics.push({
        type: "ambiguous-cue-reference",
        cueFrameId: frame.cueFrameId,
        sourceShapeIds: sourceCues.map((item) => item.shape.id),
        subShapeId: shape.id,
      });
    }
    frameByShapeId.set(shape.id, {
      ...frame,
      id: newFrameIdBySourceShapeId.get(shape.id) ?? frame.id,
      cueFrameId: representative
        ? (newFrameIdBySourceShapeId.get(representative.shape.id) ??
          representative.frame.id)
        : frame.cueFrameId,
    });
  }

  for (const shape of content.shapes) {
    const frame = frameByShapeId.get(shape.id);
    if (frame) {
      shape.meta = { ...shape.meta, frame: frameToJsonObject(frame) };
    }
  }
  diagnostics.sort(
    (a, b) =>
      a.subShapeId.localeCompare(b.subShapeId) ||
      a.cueFrameId.localeCompare(b.cueFrameId),
  );
  return diagnostics;
}
