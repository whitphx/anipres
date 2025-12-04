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
import type { Frame, FrameBatch, CueFrame } from "../models";
import { calcFrameBatchUIData, FrameBatchUIData, Track } from "./frame-ui-data";
import { FrameMoveTogetherDndContext } from "./FrameMoveTogetherDndContext";
import { DraggableFrameUI } from "./DraggableFrameUI";
import styles from "./Timeline.module.scss";
import { FrameEditor } from "./FrameEditor/FrameEditor";
import { moveFrame } from "./frame-movement";
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
  selectedFrameIds: string[];
  frameEditorRefCallback: (frameId: string) => React.RefCallback<HTMLElement>;
  draggedFrame: Frame | null;
  onFrameChange: (newFrame: Frame) => void;
  onFrameSelect: (frameId: string) => void;
  requestCueFrameAddAfter: (prevCueFrame: CueFrame) => void;
  requestSubFrameAddAfter: (prevFrame: Frame) => void;
}
const StepColumn = React.memo(
  ({
    stepIdx,
    isActive,
    onStepSelect,
    tracks,
    stepFrameBatches,
    selectedFrameIds,
    frameEditorRefCallback,
    draggedFrame,
    onFrameChange,
    onFrameSelect,
    requestSubFrameAddAfter,
    requestCueFrameAddAfter,
  }: StepColumnProps) => {
    return (
      <>
        <div className={`${styles.column} ${isActive ? styles.active : ""}`}>
          <div className={styles.headerCell}>
            <button
              className={`${styles.frameButton} ${isActive ? styles.selected : ""}`}
              onClick={() => onStepSelect(stepIdx)}
            >
              {stepIdx + 1}
            </button>
          </div>
          <DroppableArea
            type="at"
            globalIndex={stepIdx}
            className={styles.droppableColumn}
          >
            {tracks.map((track) => {
              const trackFrameBatches = stepFrameBatches.filter(
                // `trackFrameBatches.length` should always be 1, but we loop over it just in case.
                (b) => b.trackId === track.id,
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
                          trackId={track.id}
                          trackIndex={cueFrame.trackIndex}
                          globalIndex={trackFrameBatch.globalIndex}
                          frame={cueFrame}
                        >
                          <FrameEditor
                            frame={cueFrame}
                            isPlaceholder={draggedFrame?.id === cueFrame.id}
                            onUpdate={onFrameChange}
                            isSelected={selectedFrameIds.includes(cueFrame.id)}
                            onClick={() => {
                              onFrameSelect(cueFrame.id);
                            }}
                            ref={frameEditorRefCallback(cueFrame.id)}
                          />
                        </DraggableFrameUI>

                        {subFrames.map((subFrame) => {
                          return (
                            <DraggableFrameUI
                              key={subFrame.id}
                              id={subFrame.id}
                              trackId={track.id}
                              trackIndex={subFrame.trackIndex}
                              globalIndex={trackFrameBatch.globalIndex}
                              frame={subFrame}
                            >
                              <FrameEditor
                                frame={subFrame}
                                isPlaceholder={draggedFrame?.id === subFrame.id}
                                onUpdate={onFrameChange}
                                isSelected={selectedFrameIds.includes(
                                  subFrame.id,
                                )}
                                onClick={() => {
                                  onFrameSelect(subFrame.id);
                                }}
                                ref={frameEditorRefCallback(subFrame.id)}
                              />
                            </DraggableFrameUI>
                          );
                        })}
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
                              onClick={() => requestCueFrameAddAfter(cueFrame)}
                            >
                              +
                            </FrameIcon>
                          </div>
                        </div>
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

interface TimelineProps {
  frameBatches: FrameBatch[];
  onFrameChange: (newFrame: Frame) => void;
  onFrameBatchesChange: (newFrameBatches: FrameBatch[]) => void;
  currentStepIndex: number;
  onStepSelect: (stepIndex: number) => void;
  shapeSelections: ShapeSelection[];
  onFrameSelect: (frameId: string) => void;
  requestCueFrameAddAfter: (prevCueFrame: CueFrame) => void;
  requestSubFrameAddAfter: (prevFrame: Frame) => void;
  requestCueFrameAddAfterGroup: (shapeSelection: ShapeSelection) => void;
  showAttachCueFrameButton: boolean;
  requestAttachCueFrame: () => void;
}
export function Timeline({
  frameBatches,
  onFrameChange,
  onFrameBatchesChange,
  currentStepIndex,
  onStepSelect,
  shapeSelections,
  onFrameSelect,
  requestCueFrameAddAfter,
  requestSubFrameAddAfter,
  requestCueFrameAddAfterGroup,
  showAttachCueFrameButton,
  requestAttachCueFrame,
}: TimelineProps) {
  const { steps, tracks } = useMemo(
    () => calcFrameBatchUIData(frameBatches),
    [frameBatches],
  );

  const containerRef = React.useRef<HTMLDivElement>(null);
  const [frameEditorDOMs, setFrameEditorDOMs] = useState<
    Record<string, HTMLElement>
  >({});
  const frameEditorRefCallback = useCallback(
    (frameId: string): React.RefCallback<HTMLElement> =>
      (elem) => {
        if (elem != null) {
          setFrameEditorDOMs((prev) => ({ ...prev, [frameId]: elem }));
        } else {
          setFrameEditorDOMs((prev) => {
            const newState = { ...prev };
            delete newState[frameId];
            return newState;
          });
        }
      },
    [],
  );

  const selectedFrameIds = useMemo(() => {
    return shapeSelections.flatMap((sel) => sel.frameIds);
  }, [shapeSelections]);
  const groupSelectionAndEditorDOMs = useMemo(() => {
    const groupSelections = shapeSelections.filter(
      (sel) => sel.frameIds.length > 1,
    );
    return groupSelections.map((groupSelection) => {
      const elements = groupSelection.frameIds
        .map((frameId) => frameEditorDOMs[frameId])
        .filter((elem) => elem !== null);
      return {
        groupSelection: groupSelection,
        elements,
      };
    });
  }, [shapeSelections, frameEditorDOMs]);

  const [draggedFrame, setDraggedFrame] = useState<Frame | null>(null);

  const handleDragStart = useCallback<
    NonNullable<DndContextProps["onDragStart"]>
  >((event) => {
    const { active } = event;
    const frame = active.data.current?.frame as Frame | undefined;
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
        trackId,
        srcGlobalIndex,
        srcTrackIndex,
        dstGlobalIndex,
        dstType,
      );
      if (newSteps != null) {
        onFrameBatchesChange(newSteps.flat());
      }
    },
    [steps, onFrameBatchesChange],
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
      autoScroll={{
        // Disable vertical auto-scroll. Ref: https://github.com/clauderic/dnd-kit/issues/825#issuecomment-1459162477
        threshold: {
          x: 0.2, // Default value: https://github.com/clauderic/dnd-kit/blob/e9215e820798459ae036896fce7fd9a6fe855772/packages/core/src/utilities/scroll/getScrollDirectionAndSpeed.ts#L8
          y: 0,
        },
      }}
    >
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
              selectedFrameIds={selectedFrameIds}
              frameEditorRefCallback={frameEditorRefCallback}
              draggedFrame={draggedFrame}
              onFrameChange={onFrameChange}
              onFrameSelect={onFrameSelect}
              requestSubFrameAddAfter={requestSubFrameAddAfter}
              requestCueFrameAddAfter={requestCueFrameAddAfter}
            />
          );
        })}
        {showAttachCueFrameButton && (
          <div className={styles.column}>
            <div className={styles.headerCell}>{steps.length + 1}</div>
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
                isSelected={selectedFrameIds.includes(draggedFrame.id)}
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
