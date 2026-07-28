import {
  GroupShapeUtil,
  createShapeId,
  getIndexAbove,
  stopEventPropagation,
  track,
  uniqueId,
} from "tldraw";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  cueFrameToJsonObject,
  frameToJsonObject,
  getFrame,
  getLeafShapes,
  makeInsertionSpace,
  newStepId,
  type CueFrame,
  type Frame,
  type FrameRecord,
  type SubFrame,
  type TimelineDiagnostic,
} from "../models";
import { Timeline, type ShapeSelection } from "../Timeline";
import type { PresentationManager } from "../presentation-manager";
import { SlideShapeType } from "../shapes/slide/SlideShape";
import styles from "./ControlPanel.module.scss";

const COPIED_SHAPE_POSITION_OFFSET = { x: 100, y: 100 };

export interface ControlPanelProps {
  editor: Editor;
  presentationManager: PresentationManager;
  currentStepIndex: number;
  onCurrentStepIndexChange: (newIndex: number) => void;
  onPresentationModeEnter: () => void;
}

export const ControlPanel = track((props: ControlPanelProps) => {
  const {
    editor,
    presentationManager,
    currentStepIndex,
    onCurrentStepIndexChange,
    onPresentationModeEnter,
  } = props;
  const timeline = presentationManager.$getTimeline();
  const frameRecords = presentationManager.$getAllFrameRecords();
  const recordByShapeId = new Map(
    frameRecords.map((record) => [record.shapeId, record]),
  );
  const selectedShapes = editor.getSelectedShapes();
  const shapeSelections: ShapeSelection[] = selectedShapes.map((shape) => ({
    shapeId: shape.id,
    frameIds: getLeafShapes(editor, shape)
      .map(getFrame)
      .filter((frame): frame is Frame => frame !== undefined)
      .map((frame) => frame.id),
  }));
  const selectedAnimeFrameAttachableShapes = selectedShapes.filter((shape) => {
    if (shape.type === SlideShapeType) return false;
    if (shape.type !== GroupShapeUtil.type)
      return getFrame(shape) === undefined;
    return getLeafShapes(editor, shape).every(
      (leafShape) => getFrame(leafShape) === undefined,
    );
  });
  const selectedCueRecord = selectedShapes
    .flatMap((shape) => getLeafShapes(editor, shape))
    .map((shape) => recordByShapeId.get(shape.id))
    .filter(
      (record): record is FrameRecord & { frame: CueFrame } =>
        record?.frame.type === "cue",
    )
    .sort(
      (a, b) =>
        a.frame.id.localeCompare(b.frame.id) ||
        a.shapeId.localeCompare(b.shapeId),
    )[0];

  const applyFrameMutations = (
    mutations: { shapeId: string; frame: Frame }[],
  ) => {
    editor.updateShapes(
      mutations.flatMap(({ shapeId, frame }) => {
        const shape = editor.getShape(shapeId as TLShapeId);
        return shape
          ? [
              {
                id: shape.id,
                type: shape.type,
                meta: { ...shape.meta, frame: frameToJsonObject(frame) },
              },
            ]
          : [];
      }),
    );
  };

  const storedStepEntries = timeline.steps.flatMap((step) => {
    if (step.synthetic) return [];
    const cueRecords = step.batches.flatMap((batch) => {
      const record = recordByShapeId.get(batch.frames[0].shapeId);
      return record?.frame.type === "cue" ? [record] : [];
    });
    const representative = [...cueRecords].sort(
      (a, b) =>
        a.frame.id.localeCompare(b.frame.id) ||
        a.shapeId.localeCompare(b.shapeId),
    )[0];
    return representative?.frame.type === "cue"
      ? [
          {
            id: step.id,
            key: representative.frame.stepOrderKey,
            cueRecords,
          },
        ]
      : [];
  });

  const makeStepAfter = (stepId: string) => {
    const sourceIndex = storedStepEntries.findIndex(
      (step) => step.id === stepId,
    );
    const insertionIndex =
      sourceIndex < 0 ? storedStepEntries.length : sourceIndex + 1;
    const insertion = makeInsertionSpace(storedStepEntries, insertionIndex);
    const normalizationMutations = insertion.updates.flatMap((update) => {
      const step = storedStepEntries.find((entry) => entry.id === update.id);
      return (step?.cueRecords ?? []).map((record) => ({
        shapeId: record.shapeId,
        frame: { ...record.frame, stepOrderKey: update.key } as CueFrame,
      }));
    });
    return {
      stepId: newStepId(),
      stepOrderKey: insertion.insertedKey,
      normalizationMutations,
    };
  };

  const clearFrame = (shapeId: TLShapeId) => {
    const shape = editor.getShape(shapeId);
    if (!shape) return;
    const meta = { ...shape.meta };
    delete meta.frame;
    editor.updateShape({ id: shape.id, type: shape.type, meta });
  };

  const resolveDiagnostic = (diagnostic: TimelineDiagnostic) => {
    if (diagnostic.type === "invalid-frame") {
      clearFrame(diagnostic.shapeId);
      return;
    }
    if (diagnostic.type === "detached-sub-frame") {
      clearFrame(diagnostic.shapeId);
      return;
    }
    if (diagnostic.type === "step-key-divergence") {
      const records = frameRecords
        .filter(
          (record): record is FrameRecord & { frame: CueFrame } =>
            record.frame.type === "cue" &&
            record.frame.stepId === diagnostic.stepId,
        )
        .sort(
          (a, b) =>
            a.frame.id.localeCompare(b.frame.id) ||
            a.shapeId.localeCompare(b.shapeId),
        );
      const key = records[0]?.frame.stepOrderKey;
      if (!key) return;
      applyFrameMutations(
        records.map((record) => ({
          shapeId: record.shapeId,
          frame: { ...record.frame, stepOrderKey: key },
        })),
      );
      return;
    }
    if (diagnostic.type === "duplicate-frame-id") {
      const duplicates = frameRecords
        .filter((record) => record.frame.id === diagnostic.frameId)
        .sort((a, b) => a.shapeId.localeCompare(b.shapeId));
      applyFrameMutations(
        duplicates.slice(1).map((record) => ({
          shapeId: record.shapeId,
          frame: { ...record.frame, id: uniqueId() },
        })),
      );
      return;
    }
    const conflictRecords = frameRecords
      .filter(
        (record): record is FrameRecord & { frame: CueFrame } =>
          record.frame.type === "cue" &&
          record.frame.stepId === diagnostic.stepId &&
          record.frame.trackId === diagnostic.trackId,
      )
      .sort(
        (a, b) =>
          a.frame.id.localeCompare(b.frame.id) ||
          a.shapeId.localeCompare(b.shapeId),
      );
    const representativeShapeId = conflictRecords[0]?.shapeId;
    const splitRecord = conflictRecords.find(
      (record) =>
        record.shapeId !== representativeShapeId &&
        diagnostic.shapeIds.includes(record.shapeId),
    );
    if (!splitRecord) return;
    const insertion = makeStepAfter(diagnostic.stepId);
    applyFrameMutations([
      ...insertion.normalizationMutations,
      {
        shapeId: splitRecord.shapeId,
        frame: {
          ...splitRecord.frame,
          stepId: insertion.stepId,
          stepOrderKey: insertion.stepOrderKey,
        },
      },
    ]);
  };

  const reattachDetached = (
    diagnostic: Extract<TimelineDiagnostic, { type: "detached-sub-frame" }>,
  ) => {
    const record = recordByShapeId.get(diagnostic.shapeId);
    if (record?.frame.type !== "sub" || !selectedCueRecord) return;
    const targetBatch = timeline.steps
      .flatMap((step) => step.batches)
      .find((batch) => batch.frames[0]?.shapeId === selectedCueRecord.shapeId);
    const lastFrame = targetBatch?.frames.at(-1);
    const lastRecord = lastFrame
      ? recordByShapeId.get(lastFrame.shapeId)
      : undefined;
    applyFrameMutations([
      {
        shapeId: record.shapeId,
        frame: {
          ...record.frame,
          cueFrameId: selectedCueRecord.frame.id,
          orderKey:
            lastRecord?.frame.type === "sub"
              ? getIndexAbove(lastRecord.frame.orderKey as never)
              : getIndexAbove(),
        },
      },
    ]);
  };

  return (
    <div
      className={styles.panelContainer}
      style={{ pointerEvents: "all" }}
      onPointerDown={(event) => stopEventPropagation(event)}
    >
      <div>
        <button
          type="button"
          aria-label="Enter presentation mode"
          className={styles.playButton}
          onClick={onPresentationModeEnter}
        >
          ▶️
        </button>
      </div>
      <div className={styles.scrollableContainer}>
        <Timeline
          timeline={timeline}
          frameRecords={frameRecords}
          onFrameMutations={applyFrameMutations}
          onFrameChange={(newFrame, shapeId) =>
            applyFrameMutations([{ shapeId, frame: newFrame }])
          }
          currentStepIndex={currentStepIndex}
          onStepSelect={onCurrentStepIndexChange}
          shapeSelections={shapeSelections}
          onFrameSelect={(shapeId) => editor.select(shapeId as TLShapeId)}
          onResolveDiagnostic={resolveDiagnostic}
          onDiagnosticSelect={(diagnostic) => {
            const shapeId =
              "shapeId" in diagnostic
                ? diagnostic.shapeId
                : diagnostic.shapeIds[0];
            if (shapeId) editor.select(shapeId);
          }}
          onReattachDetached={reattachDetached}
          canReattachDetached={selectedCueRecord !== undefined}
          showAttachCueFrameButton={
            selectedAnimeFrameAttachableShapes.length > 0
          }
          requestAttachCueFrame={() => {
            selectedAnimeFrameAttachableShapes.forEach((shape) =>
              presentationManager.attachCueFrame(shape.id, {
                type: "shapeAnimation",
              }),
            );
          }}
          requestCueFrameAddAfter={(previousCueFrame) => {
            const previousShape = presentationManager.getShapeByFrameId(
              previousCueFrame.id,
            );
            if (!previousShape) return;
            const insertion = makeStepAfter(previousCueFrame.stepId);
            const newFrame: CueFrame = {
              v: 2,
              id: uniqueId(),
              type: "cue",
              trackId: previousCueFrame.trackId,
              stepId: insertion.stepId,
              stepOrderKey: insertion.stepOrderKey,
              action: {
                type: previousCueFrame.action.type,
                duration: 1000,
              },
            };
            editor.run(() => {
              applyFrameMutations(insertion.normalizationMutations);
              const shapeId = createShapeId();
              editor.createShape({
                ...previousShape,
                id: shapeId,
                x: previousShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
                y: previousShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
                meta: {
                  ...previousShape.meta,
                  frame: cueFrameToJsonObject(newFrame),
                },
              });
              editor.select(shapeId);
            });
          }}
          requestCueFrameAddAfterGroup={(selection) => {
            const selectedFrameIds = new Set(selection.frameIds);
            const selectedLastFrameIdByTrack = new Map<string, string>();
            for (const step of timeline.steps) {
              for (const batch of step.batches) {
                for (const frame of batch.frames) {
                  if (selectedFrameIds.has(frame.frameId)) {
                    selectedLastFrameIdByTrack.set(
                      batch.trackId,
                      frame.frameId,
                    );
                  }
                }
              }
            }
            const selectedLastFrameIds = new Set(
              selectedLastFrameIdByTrack.values(),
            );
            const cloneRecursively = (
              rootShapeId: TLShapeId,
              parentShapeId?: TLShapeId,
            ): { original: TLShape; copied: TLShape }[] => {
              const original = editor.getShape(rootShapeId);
              if (!original) return [];
              const frame = getFrame(original);
              const shouldCopy =
                original.type === GroupShapeUtil.type ||
                (frame !== undefined && selectedLastFrameIds.has(frame.id));
              if (!shouldCopy) {
                return editor
                  .getSortedChildIdsForParent(rootShapeId)
                  .flatMap((childId) =>
                    cloneRecursively(childId, parentShapeId),
                  );
              }
              const shapeId = createShapeId();
              const isRoot = parentShapeId === undefined;
              const transform = isRoot
                ? editor.getShapePageTransform(original).decomposed()
                : { x: original.x, y: original.y, rotation: original.rotation };
              const copied: TLShape = {
                ...original,
                id: shapeId,
                x: transform.x + (isRoot ? COPIED_SHAPE_POSITION_OFFSET.x : 0),
                y: transform.y + (isRoot ? COPIED_SHAPE_POSITION_OFFSET.y : 0),
                rotation: transform.rotation,
                parentId: parentShapeId ?? editor.getCurrentPageId(),
              };
              return [
                { original, copied },
                ...editor
                  .getSortedChildIdsForParent(rootShapeId)
                  .flatMap((childId) => cloneRecursively(childId, shapeId)),
              ];
            };
            const clones = cloneRecursively(selection.shapeId);
            const previousCues = clones.flatMap(({ original }) => {
              const frame = getFrame(original);
              const cue = frame
                ? presentationManager.$getAssociatedCueFrames()[frame.id]
                : undefined;
              return cue ? [cue] : [];
            });
            const latestPreviousCue = previousCues
              .map((cue) => ({
                cue,
                index: timeline.steps.findIndex(
                  (step) => step.id === cue.stepId,
                ),
              }))
              .sort((a, b) => b.index - a.index)[0]?.cue;
            if (!latestPreviousCue) return;
            const insertion = makeStepAfter(latestPreviousCue.stepId);
            for (const { original, copied } of clones) {
              if (original.type === GroupShapeUtil.type) continue;
              const originalFrame = getFrame(original);
              const previousCue = originalFrame
                ? presentationManager.$getAssociatedCueFrames()[
                    originalFrame.id
                  ]
                : undefined;
              if (!previousCue) continue;
              const frame: CueFrame = {
                v: 2,
                id: copied.id,
                type: "cue",
                trackId: previousCue.trackId,
                stepId: insertion.stepId,
                stepOrderKey: insertion.stepOrderKey,
                action: {
                  type: originalFrame?.action.type ?? "shapeAnimation",
                  duration: 1000,
                },
              };
              copied.meta = { ...copied.meta, frame: frameToJsonObject(frame) };
            }
            editor.run(() => {
              applyFrameMutations(insertion.normalizationMutations);
              editor.createShapes(clones.map(({ copied }) => copied));
              const root = clones.find(
                ({ copied }) => copied.parentId === editor.getCurrentPageId(),
              )?.copied;
              if (root) editor.select(root);
            });
          }}
          requestSubFrameAddAfter={(previousFrame) => {
            const previousShape = presentationManager.getShapeByFrameId(
              previousFrame.id,
            );
            const cue =
              presentationManager.$getAssociatedCueFrames()[previousFrame.id];
            if (!previousShape || !cue) return;
            const batch = timeline.steps
              .flatMap((step) => step.batches)
              .find((item) =>
                item.frames.some((frame) => frame.frameId === previousFrame.id),
              );
            const lastSubRecord = batch?.frames
              .slice(1)
              .map((frame) => recordByShapeId.get(frame.shapeId))
              .filter(
                (record): record is FrameRecord & { frame: SubFrame } =>
                  record?.frame.type === "sub",
              )
              .at(-1);
            const newFrame: SubFrame = {
              v: 2,
              id: uniqueId(),
              type: "sub",
              cueFrameId: cue.id,
              orderKey: getIndexAbove(lastSubRecord?.frame.orderKey as never),
              action: { type: previousFrame.action.type, duration: 1000 },
            };
            const shapeId = createShapeId();
            editor.createShape({
              ...previousShape,
              id: shapeId,
              x: previousShape.x + COPIED_SHAPE_POSITION_OFFSET.x,
              y: previousShape.y + COPIED_SHAPE_POSITION_OFFSET.y,
              meta: {
                ...previousShape.meta,
                frame: frameToJsonObject(newFrame),
              },
            });
            editor.select(shapeId);
          }}
        />
      </div>
    </div>
  );
});
