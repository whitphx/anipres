import { uniqueId } from "tldraw";
import type { TLContent, TLShape, TLShapeId } from "tldraw";
import {
  frameToJsonObject,
  getFrameRecords,
  makeInsertionSpace,
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

export interface AnimationContentPreprocessResult {
  diagnostics: ContentPreprocessDiagnostic[];
  existingFrameMutations: { shapeId: TLShapeId; frame: CueFrame }[];
}

export function preprocessAnimationContent(
  content: TLContent,
  existingShapes: readonly TLShape[],
  options: AnimationContentPreprocessOptions = {},
): AnimationContentPreprocessResult {
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

  const existingCueRecords = existingRecords.filter(
    (record): record is typeof record & { frame: CueFrame } =>
      record.frame.type === "cue",
  );
  const cueRecordsByStepId = new Map<string, typeof existingCueRecords>();
  for (const record of existingCueRecords) {
    const group = cueRecordsByStepId.get(record.frame.stepId) ?? [];
    group.push(record);
    cueRecordsByStepId.set(record.frame.stepId, group);
  }
  const workingSteps = [...cueRecordsByStepId.entries()]
    .map(([id, cueRecords]) => {
      cueRecords.sort(
        (a, b) =>
          a.frame.id.localeCompare(b.frame.id) ||
          a.shapeId.localeCompare(b.shapeId),
      );
      return { id, key: cueRecords[0].frame.stepOrderKey, cueRecords };
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
  const copiedStepOrderKey = new Map<string, string>();
  const existingFrameMutationByShapeId = new Map<
    TLShapeId,
    { shapeId: TLShapeId; frame: CueFrame }
  >();
  for (const stepId of [...stepIdsToRemap].sort()) {
    const originalIndex = workingSteps.findIndex((step) => step.id === stepId);
    const insertionIndex =
      originalIndex < 0 ? workingSteps.length : originalIndex + 1;
    const insertion = makeInsertionSpace(workingSteps, insertionIndex);
    for (const update of insertion.updates) {
      const step = workingSteps.find((candidate) => candidate.id === update.id);
      if (!step) continue;
      step.key = update.key;
      for (const record of step.cueRecords) {
        existingFrameMutationByShapeId.set(record.shapeId, {
          shapeId: record.shapeId,
          frame: { ...record.frame, stepOrderKey: update.key },
        });
      }
    }
    copiedStepOrderKey.set(stepId, insertion.insertedKey);
    workingSteps.splice(insertionIndex, 0, {
      id: stepIdMap.get(stepId)!,
      key: insertion.insertedKey,
      cueRecords: [],
    });
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
  const copiedCueFrameIds = new Set(cues.map((cue) => cue.frame.id));
  const externalCueFrameIdMap = new Map<string, string>();
  for (const cueFrameId of [
    ...new Set(
      frames.flatMap(({ frame }) =>
        frame.type === "sub" && !copiedCueFrameIds.has(frame.cueFrameId)
          ? [frame.cueFrameId]
          : [],
      ),
    ),
  ].sort()) {
    externalCueFrameIdMap.set(cueFrameId, createFrameId());
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
        : externalCueFrameIdMap.get(frame.cueFrameId)!,
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
  return {
    diagnostics,
    existingFrameMutations: [...existingFrameMutationByShapeId.values()].sort(
      (a, b) => a.shapeId.localeCompare(b.shapeId),
    ),
  };
}
