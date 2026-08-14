import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  useDroppable,
  useDndContext,
  useSensors,
  useSensor,
  DragOverlay,
  KeyboardSensor,
  type DndContextProps,
} from "@dnd-kit/core";
import { PointerSensor, MouseSensor, TouchSensor } from "./dnd-sensors";
import type {
  EditedStep,
  TimelineDiagnostic,
  TimelineDoc,
} from "../timeline-model";
import {
  calcFrameBatchUIData,
  FrameBatchUIData,
  FrameUIData,
  Track,
} from "./frame-ui-data";
import { FrameMoveTogetherDndContext } from "./FrameMoveTogetherDndContext";
import { DraggableFrameUI } from "./DraggableFrameUI";
import styles from "./Timeline.module.scss";
import { FrameEditor } from "./FrameEditor/FrameEditor";
import { moveFrame } from "./frame-movement";
import { hasSimultaneousMediaEvents } from "./media-event-conflicts";
import { DelegateTldrawCssVars } from "./DelegateTldrawCssVars";
import { GroupSelection } from "./GroupSelection";
import type { ShapeSelection } from "./selection";

interface DragStateStyleDivProps {
  children: React.ReactNode;
  className: string;
  classNameWhenDragging: string;
}
const DragStateStyleDiv = React.forwardRef<
  HTMLDivElement,
  DragStateStyleDivProps
>((props, ref) => {
  const { active } = useDndContext();
  return (
    <div
      ref={ref}
      className={active != null ? props.classNameWhenDragging : props.className}
    >
      {props.children}
    </div>
  );
});
DragStateStyleDiv.displayName = "DragStateStyleDiv";

interface FrameIconProps {
  isSelected?: boolean;
  subFrame?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
  as?: React.ElementType;
}
const FrameIcon = React.forwardRef<HTMLElement, FrameIconProps>(
  (props, ref) => {
    return React.createElement(
      props.as ?? "div",
      {
        ref,
        className: `${styles.frameIcon} ${props.isSelected ? styles.selected : ""} ${props.subFrame ? styles.subFrame : ""}`,
        onClick: props.onClick,
      },
      props.children,
    );
  },
);
FrameIcon.displayName = "FrameIcon";

function DroppableArea({
  type,
  globalIndex,
  children,
  className,
}: {
  type: "at" | "after";
  globalIndex: number;
  children?: React.ReactNode;
  className?: string;
}) {
  const droppableId = `${type}-${globalIndex}`;
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: {
      type,
      globalIndex,
    },
  });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.droppableCell} ${isOver ? styles.over : ""} ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

interface StepColumnProps {
  stepIdx: number;
  isActive: boolean;
  onStepSelect: (stepIndex: number) => void;
  tracks: Track[];
  stepFrameBatches: FrameBatchUIData[];
  selectedFrameShapeIds: string[];
  frameEditorRefCallback: (
    frameShapeId: string,
  ) => React.RefCallback<HTMLElement>;
  draggedFrame: FrameUIData | null;
  onFrameChange: (newFrame: FrameUIData) => void;
  onFrameDelete: (frame: FrameUIData) => void;
  onFrameSelect: (frameShapeId: string) => void;
  requestCueFrameAddAfter: (prevCueFrame: FrameUIData) => void;
  requestSubFrameAddAfter: (prevFrame: FrameUIData) => void;
  canExtendFrameSequence: (cueFrame: FrameUIData) => boolean;
}
const StepColumn = React.memo(
  ({
    stepIdx,
    isActive,
    onStepSelect,
    tracks,
    stepFrameBatches,
    selectedFrameShapeIds,
    frameEditorRefCallback,
    draggedFrame,
    onFrameChange,
    onFrameDelete,
    onFrameSelect,
    requestSubFrameAddAfter,
    requestCueFrameAddAfter,
    canExtendFrameSequence,
  }: StepColumnProps) => {
    return (
      <>
        <div className={`${styles.column} ${isActive ? styles.active : ""}`}>
          <div className={styles.headerCell}>
            <button
              type="button"
              className={`${styles.frameButton} ${isActive ? styles.selected : ""}`}
              onClick={() => onStepSelect(stepIdx)}
              aria-label={`Go to step ${stepIdx}`}
              aria-current={isActive ? "step" : undefined}
            >
              {/* Zero-based so the label counts advances: step N is
                  where the presentation lands after N "next" actions. */}
              {stepIdx}
            </button>
          </div>
          <DroppableArea
            type="at"
            globalIndex={stepIdx}
            className={styles.droppableColumn}
          >
            {tracks.map((track) => {
              const trackFrameBatches = stepFrameBatches.filter(
                // One batch per source track; a row merging several
                // tracks (one video's keyframes + media events) can hold
                // one batch from each in the same step.
                (b) => track.trackIds.includes(b.trackId),
              );
              return (
                <div key={track.id} className={styles.frameBatchCell}>
                  {trackFrameBatches.map((trackFrameBatch) => {
                    const frames = trackFrameBatch.data;

                    const [cueFrame, ...subFrames] = frames;
                    return (
                      <div
                        key={trackFrameBatch.id}
                        className={styles.frameBatchControl}
                      >
                        <DraggableFrameUI
                          id={trackFrameBatch.id}
                          // The batch's real track id, not the row id:
                          // drag & drop identifies frames by (trackId,
                          // trackIndex) in the data model's terms.
                          trackId={trackFrameBatch.trackId}
                          trackIndex={cueFrame.trackIndex}
                          globalIndex={trackFrameBatch.globalIndex}
                          frame={cueFrame}
                        >
                          <FrameEditor
                            frame={cueFrame}
                            isPlaceholder={
                              draggedFrame?.shapeId === cueFrame.shapeId
                            }
                            onUpdate={onFrameChange}
                            onDelete={() => onFrameDelete(cueFrame)}
                            isSelected={selectedFrameShapeIds.includes(
                              cueFrame.shapeId,
                            )}
                            onClick={() => {
                              onFrameSelect(cueFrame.shapeId);
                            }}
                            ref={frameEditorRefCallback(cueFrame.shapeId)}
                          />
                        </DraggableFrameUI>

                        {subFrames.map((subFrame) => {
                          return (
                            <DraggableFrameUI
                              key={subFrame.shapeId}
                              id={subFrame.shapeId}
                              trackId={trackFrameBatch.trackId}
                              trackIndex={subFrame.trackIndex}
                              globalIndex={trackFrameBatch.globalIndex}
                              frame={subFrame}
                            >
                              <FrameEditor
                                frame={subFrame}
                                isPlaceholder={
                                  draggedFrame?.shapeId === subFrame.shapeId
                                }
                                onUpdate={onFrameChange}
                                onDelete={() => onFrameDelete(subFrame)}
                                isSelected={selectedFrameShapeIds.includes(
                                  subFrame.shapeId,
                                )}
                                onClick={() => {
                                  onFrameSelect(subFrame.shapeId);
                                }}
                                ref={frameEditorRefCallback(subFrame.shapeId)}
                              />
                            </DraggableFrameUI>
                          );
                        })}
                        {canExtendFrameSequence(cueFrame) && (
                          <div className={styles.frameAddButtonContainer}>
                            <FrameIcon
                              as="button"
                              subFrame
                              onClick={() =>
                                requestSubFrameAddAfter(frames.at(-1)!)
                              }
                            >
                              +
                            </FrameIcon>
                            <div className={styles.hoverExpandedPart}>
                              <FrameIcon
                                as="button"
                                onClick={() =>
                                  requestCueFrameAddAfter(cueFrame)
                                }
                              >
                                +
                              </FrameIcon>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </DroppableArea>
        </div>
        <div className={styles.headerLessColumn}>
          <DroppableArea
            type="after"
            globalIndex={stepIdx}
            className={styles.inbetweenDroppableCell}
          />
        </div>
      </>
    );
  },
);
StepColumn.displayName = "StepColumn";

const AUTO_SCROLL_CONFIG = {
  // Disable vertical auto-scroll. Ref: https://github.com/clauderic/dnd-kit/issues/825#issuecomment-1459162477
  threshold: {
    x: 0.2, // Default value: https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/utilities/scroll/getScrollDirectionAndSpeed.ts#L8
    y: 0,
  },
};

const RESOLVE_LABELS: Record<TimelineDiagnostic["type"], string> = {
  "step-key-divergence": "Align step keys",
  "same-track-split": "Materialize split",
  "duplicate-frame-id": "Freshen ids",
  "detached-sub-frame": "Clear animation data",
  "invalid-frame": "Clear animation data",
  "v1-frame": "Delete animation data",
};

/** Stable identity for React keys — never array position. */
function diagnosticKey(diagnostic: TimelineDiagnostic): string {
  switch (diagnostic.type) {
    case "step-key-divergence":
      return `${diagnostic.type}:${diagnostic.stepId}`;
    case "same-track-split":
      return `${diagnostic.type}:${diagnostic.stepId}:${diagnostic.trackId}:${diagnostic.shapeIds.join(",")}`;
    case "detached-sub-frame":
      return `${diagnostic.type}:${diagnostic.shapeId}`;
    case "duplicate-frame-id":
      return `${diagnostic.type}:${diagnostic.frameId}`;
    case "invalid-frame":
      return `${diagnostic.type}:${diagnostic.shapeId}`;
    case "v1-frame":
      // One aggregated diagnostic per document.
      return diagnostic.type;
  }
}

function describeDiagnostic(diagnostic: TimelineDiagnostic): string {
  switch (diagnostic.type) {
    case "step-key-divergence":
      return "Step has conflicting order keys (concurrent edit)";
    case "same-track-split":
      return "Two keyframes of one track share a step (shown split)";
    case "detached-sub-frame":
      return "Sub frame lost its cue (deleted or missing)";
    case "duplicate-frame-id":
      return "Two shapes share one animation frame id";
    case "invalid-frame":
      return "Shape carries unreadable animation data";
    case "v1-frame":
      return `${diagnostic.shapeIds.length} shape(s) carry v1 animation data, not supported by this version`;
  }
}

interface TimelineProps {
  timelineDoc: TimelineDoc;
  /**
   * Track id → group key; tracks sharing a key render as one row (see
   * `calcFrameBatchUIData`). Must be referentially stable while its
   * content is unchanged, like `timelineDoc`.
   */
  trackGroups: Record<string, string>;
  onFrameChange: (newFrame: FrameUIData) => void;
  /** Deletes the event a frame represents; see FrameEditPopover's onDelete. */
  onFrameDelete: (frame: FrameUIData) => void;
  onEditedStepsChange: (editedSteps: EditedStep[]) => void;
  currentStepIndex: number;
  onStepSelect: (stepIndex: number) => void;
  shapeSelections: ShapeSelection[];
  onFrameSelect: (frameShapeId: string) => void;
  requestCueFrameAddAfter: (prevCueFrame: FrameUIData) => void;
  requestSubFrameAddAfter: (prevFrame: FrameUIData) => void;
  requestCueFrameAddAfterGroup: (shapeSelection: ShapeSelection) => void;
  /**
   * Whether a batch's follow-up-frame buttons are offered at all — the
   * caller decides which sequences may not be extended this way.
   */
  canExtendFrameSequence: (cueFrame: FrameUIData) => boolean;
  showAttachCueFrameButton: boolean;
  requestAttachCueFrame: () => void;
  onDiagnosticSelect: (diagnostic: TimelineDiagnostic) => void;
  onResolveDiagnostic: (diagnostic: TimelineDiagnostic) => void;
  onReattachDetached: (
    diagnostic: Extract<TimelineDiagnostic, { type: "detached-sub-frame" }>,
  ) => void;
  canReattachDetached: boolean;
}
export function Timeline({
  timelineDoc,
  trackGroups,
  onFrameChange,
  onFrameDelete,
  onEditedStepsChange,
  currentStepIndex,
  onStepSelect,
  shapeSelections,
  onFrameSelect,
  requestCueFrameAddAfter,
  requestSubFrameAddAfter,
  requestCueFrameAddAfterGroup,
  canExtendFrameSequence,
  showAttachCueFrameButton,
  requestAttachCueFrame,
  onDiagnosticSelect,
  onResolveDiagnostic,
  onReattachDetached,
  canReattachDetached,
}: TimelineProps) {
  const { steps, stepSources, tracks } = useMemo(
    () => calcFrameBatchUIData(timelineDoc, trackGroups),
    [timelineDoc, trackGroups],
  );

  const containerRef = React.useRef<HTMLDivElement>(null);
  const [frameEditorDOMs, setFrameEditorDOMs] = useState<
    Record<string, HTMLElement>
  >({});
  const frameEditorRefCallback = useCallback(
    (frameShapeId: string): React.RefCallback<HTMLElement> =>
      (elem) => {
        if (elem != null) {
          setFrameEditorDOMs((prev) => ({ ...prev, [frameShapeId]: elem }));
        } else {
          setFrameEditorDOMs((prev) => {
            const newState = { ...prev };
            delete newState[frameShapeId];
            return newState;
          });
        }
      },
    [],
  );

  const selectedFrameShapeIds = useMemo(() => {
    return shapeSelections.flatMap((sel) => sel.frameShapeIds);
  }, [shapeSelections]);
  const groupSelectionAndEditorDOMs = useMemo(() => {
    const groupSelections = shapeSelections.filter(
      (sel) => sel.frameShapeIds.length > 1,
    );
    return groupSelections.map((groupSelection) => {
      const elements = groupSelection.frameShapeIds
        .map((frameShapeId) => frameEditorDOMs[frameShapeId])
        .filter((elem) => elem !== null);
      return {
        groupSelection: groupSelection,
        elements,
      };
    });
  }, [shapeSelections, frameEditorDOMs]);

  const [draggedFrame, setDraggedFrame] = useState<FrameUIData | null>(null);

  const handleDragStart = useCallback<
    NonNullable<DndContextProps["onDragStart"]>
  >((event) => {
    const { active } = event;
    const frame = active.data.current?.frame as FrameUIData | undefined;
    if (frame == null) {
      return;
    }
    setDraggedFrame(frame);
  }, []);

  const handleDragEnd = useCallback<NonNullable<DndContextProps["onDragEnd"]>>(
    (event) => {
      const { over, active } = event;

      setDraggedFrame(null);

      if (over == null) {
        // Not dropped on any droppable
        return;
      }

      const trackId = active.data.current?.trackId;
      const srcTrackIndex = active.data.current?.trackIndex;
      const srcGlobalIndex = active.data.current?.globalIndex;
      const dstType = over.data.current?.type;
      const dstGlobalIndex = over.data.current?.globalIndex;
      if (
        !(
          typeof trackId === "string" &&
          typeof srcTrackIndex === "number" &&
          typeof srcGlobalIndex === "number" &&
          typeof dstGlobalIndex === "number" &&
          (dstType === "at" || dstType === "after")
        )
      ) {
        return;
      }

      const newSteps = moveFrame(
        steps,
        stepSources,
        trackId,
        srcGlobalIndex,
        srcTrackIndex,
        dstGlobalIndex,
        dstType,
      );
      // Refused rather than accepted-and-flagged: the drop is the only
      // way to pair two of a video's events in one step, and the two
      // would then run in an order nothing in the document records.
      if (newSteps != null && !hasSimultaneousMediaEvents(newSteps)) {
        onEditedStepsChange(newSteps);
      }
    },
    [steps, stepSources, onEditedStepsChange],
  );

  // To capture click events on draggable elements.
  // Ref: https://github.com/clauderic/dnd-kit/issues/591
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 100,
        tolerance: 1,
      },
    }),
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor),
  );

  return (
    <FrameMoveTogetherDndContext
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      sensors={sensors}
      autoScroll={AUTO_SCROLL_CONFIG}
    >
      {/* Stable live region: rendered unconditionally so assistive tech
          announces diagnostics as they APPEAR; stable content-derived
          keys keep unchanged entries' DOM nodes intact so a re-derivation
          (every shape edit) does not re-announce the whole list. */}
      <div
        className={
          timelineDoc.diagnostics.length > 0
            ? styles.diagnosticsPanel
            : undefined
        }
        aria-live="polite"
      >
        {timelineDoc.diagnostics.map((diagnostic) => (
          <div
            key={diagnosticKey(diagnostic)}
            className={styles.diagnosticItem}
          >
            <span>{describeDiagnostic(diagnostic)}</span>
            <button
              type="button"
              onClick={() => onDiagnosticSelect(diagnostic)}
            >
              Select shape
            </button>
            {diagnostic.type === "detached-sub-frame" && (
              <button
                type="button"
                disabled={!canReattachDetached}
                onClick={() => onReattachDetached(diagnostic)}
              >
                Reattach to selected cue
              </button>
            )}
            <button
              type="button"
              onClick={() => onResolveDiagnostic(diagnostic)}
            >
              {RESOLVE_LABELS[diagnostic.type]}
            </button>
          </div>
        ))}
      </div>
      <DragStateStyleDiv
        ref={containerRef}
        className={styles.timelineContainer}
        classNameWhenDragging={`${styles.timelineContainer} ${styles.dragging}`}
      >
        <div className={styles.headerLessColumn}>
          <DroppableArea
            type="after"
            globalIndex={-1}
            className={styles.inbetweenDroppableCell}
          />
        </div>
        {steps.map((stepFrameBatches, stepIdx) => {
          const isActive = stepIdx === currentStepIndex;
          return (
            <StepColumn
              key={stepFrameBatches[0].id}
              stepIdx={stepIdx}
              isActive={isActive}
              onStepSelect={onStepSelect}
              tracks={tracks}
              stepFrameBatches={stepFrameBatches}
              selectedFrameShapeIds={selectedFrameShapeIds}
              frameEditorRefCallback={frameEditorRefCallback}
              draggedFrame={draggedFrame}
              onFrameChange={onFrameChange}
              onFrameDelete={onFrameDelete}
              onFrameSelect={onFrameSelect}
              requestSubFrameAddAfter={requestSubFrameAddAfter}
              requestCueFrameAddAfter={requestCueFrameAddAfter}
              canExtendFrameSequence={canExtendFrameSequence}
            />
          );
        })}
        {showAttachCueFrameButton && (
          <div className={styles.column}>
            <div className={styles.headerCell}>{steps.length}</div>
            {tracks.map((track) => (
              <div key={track.id} className={styles.frameBatchCell}></div>
            ))}
            <div className={styles.frameBatchCell}>
              <FrameIcon
                as="button"
                isSelected={true}
                onClick={() => requestAttachCueFrame()}
              >
                +
              </FrameIcon>
            </div>
          </div>
        )}
        {groupSelectionAndEditorDOMs.map(({ groupSelection, elements }) => (
          <GroupSelection
            key={groupSelection.shapeId}
            groupSelection={groupSelection}
            containerRef={containerRef}
            frameEditorDOMs={elements}
            requestCueFrameAddAfter={requestCueFrameAddAfterGroup}
          />
        ))}
      </DragStateStyleDiv>
      {createPortal(
        <DelegateTldrawCssVars>
          <DragOverlay
            style={{
              pointerEvents: "none", // Prevent click events from being propagated to document.body, which unexpectedly triggers exiting the edit mode in the Slidev addon.
            }}
          >
            {draggedFrame != null && (
              <FrameEditor
                frame={draggedFrame}
                isPlaceholder={false}
                onUpdate={() => {}}
                onDelete={() => {}}
                isSelected={selectedFrameShapeIds.includes(
                  draggedFrame.shapeId,
                )}
                onClick={() => {}}
              />
            )}
          </DragOverlay>
        </DelegateTldrawCssVars>,
        document.body,
      )}
    </FrameMoveTogetherDndContext>
  );
}
