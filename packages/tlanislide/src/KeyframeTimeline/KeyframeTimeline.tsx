import React, { useCallback, useMemo } from "react";
import {
  useDroppable,
  useDndContext,
  useSensors,
  useSensor,
  PointerSensor,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  type DndContextProps,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { moveItemPreservingLocalOrder } from "../ordered-track-item";
import {
  EASINGS,
  TldrawUiPopover,
  TldrawUiPopoverTrigger,
  TldrawUiPopoverContent,
} from "tldraw";
import type { Frame, FrameBatch, Keyframe } from "../models";
import {
  calcFrameBatchUIData,
  type FrameBatchUIData,
} from "./keyframe-ui-data";
import { useAnimatedActiveColumnIndicator } from "./useAnimatedActiveColumnIndicator";
import { KeyframeMoveTogetherDndContext } from "./KeyframeMoveTogetherDndContext";
import { DraggableKeyframeUI } from "./DraggableKeyframeUI";
import styles from "./KeyframeTimeline.module.scss";

const EASINGS_OPTIONS = Object.keys(EASINGS);
function isEasingOption(value: string): value is keyof typeof EASINGS {
  return EASINGS_OPTIONS.includes(value);
}

interface NumberFieldProps {
  label: string;
  value: number;
  max: number;
  onChange: (newValue: number) => void;
}
function NumberField({ label, value, max, onChange }: NumberFieldProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.value === "") {
        onChange(0);
        return;
      }
      const intVal = parseInt(e.target.value);
      if (!isNaN(intVal)) {
        onChange(intVal);
      }
    },
    [onChange],
  );
  return (
    <div>
      <label>
        {label}
        <input type="number" value={value} onChange={handleChange} />
      </label>
      <input
        type="range"
        min={0}
        max={Math.max(max, value)}
        value={value}
        onChange={handleChange}
      />
    </div>
  );
}

function SelectField<T extends string[]>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: T;
  onChange: (newValue: T[number]) => void;
}) {
  return (
    <div>
      <label>
        {label}
        <select
          value={value}
          onChange={(e) => {
            if (options.includes(e.target.value)) {
              onChange(e.target.value);
            }
          }}
        >
          <option value=""></option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface KeyframeEditPopoverProps {
  keyframe: Keyframe;
  onUpdate: (newKf: Keyframe) => void;
  children: React.ReactNode;
}
function KeyframeEditPopover({
  keyframe,
  onUpdate,
  children,
}: KeyframeEditPopoverProps) {
  return (
    <TldrawUiPopover id={`keyframe-config-${keyframe.id}`}>
      <TldrawUiPopoverTrigger>{children}</TldrawUiPopoverTrigger>
      <TldrawUiPopoverContent side="bottom" sideOffset={6}>
        <div className={styles.popoverContent}>
          {keyframe.data.type === "cameraZoom" && (
            <NumberField
              label="Inset"
              value={keyframe.data.inset ?? 0}
              max={1000}
              onChange={(newInset) =>
                onUpdate({
                  ...keyframe,
                  data: {
                    ...keyframe.data,
                    inset: newInset,
                  },
                })
              }
            />
          )}
          <NumberField
            label="Duration"
            value={keyframe.data.duration ?? 0}
            max={10000}
            onChange={(newDuration) =>
              onUpdate({
                ...keyframe,
                data: {
                  ...keyframe.data,
                  duration: newDuration,
                },
              })
            }
          />
          <SelectField
            label="Easing"
            value={keyframe.data.easing ?? ""}
            options={EASINGS_OPTIONS}
            onChange={(newEasing) => {
              if (isEasingOption(newEasing)) {
                onUpdate({
                  ...keyframe,
                  data: {
                    ...keyframe.data,
                    easing: newEasing,
                  },
                });
              }
            }}
          />
        </div>
      </TldrawUiPopoverContent>
    </TldrawUiPopover>
  );
}

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

interface FrameIconProps {
  isSelected?: boolean;
  subFrame?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
  as?: React.ElementType;
}
function FrameIcon(props: FrameIconProps) {
  return React.createElement(props.as ?? "div", {
    className: `${styles.frameIcon} ${props.isSelected ? styles.selected : ""} ${props.subFrame ? styles.subFrame : ""}`,
    onClick: props.onClick,
    children: props.children,
  });
}

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

const DND_CONTEXT_MODIFIERS = [restrictToHorizontalAxis];

interface KeyframeTimelineProps {
  frameBatches: FrameBatch[];
  onKeyframeChange: (newKeyframe: Keyframe) => void;
  onFrameBatchesChange: (newFrameBatches: FrameBatch[]) => void;
  currentStepIndex: number;
  onStepSelect: (stepIndex: number) => void;
  selectedFrameIds: Frame["id"][];
  onFrameSelect: (keyframeId: string) => void;
  requestKeyframeAddAfter: (prevKeyframe: Keyframe) => void;
  showAttachKeyframeButton: boolean;
  requestAttachKeyframe: () => void;
}
export function KeyframeTimeline({
  frameBatches,
  onKeyframeChange,
  onFrameBatchesChange,
  currentStepIndex,
  onStepSelect,
  selectedFrameIds,
  onFrameSelect,
  requestKeyframeAddAfter,
  showAttachKeyframeButton,
  requestAttachKeyframe,
}: KeyframeTimelineProps) {
  const { steps, tracks } = useMemo(
    () => calcFrameBatchUIData(frameBatches),
    [frameBatches],
  );

  const handleDragEnd = useCallback<NonNullable<DndContextProps["onDragEnd"]>>(
    (event) => {
      const { over, active } = event;
      if (over == null) {
        // Not dropped on any droppable
        return;
      }

      const overType = over.data.current?.type;
      const overGlobalIndex = over.data.current?.globalIndex;
      if (
        typeof overGlobalIndex === "number" &&
        typeof overType === "string" &&
        (overType === "at" || overType === "after")
      ) {
        const activeId = active.id;

        const newFrameBatches = moveItemPreservingLocalOrder(
          frameBatches,
          activeId as FrameBatchUIData["id"],
          overGlobalIndex,
          overType,
        );
        newFrameBatches.forEach((newFrameBatch) => {
          newFrameBatch.data[0].globalIndex = newFrameBatch.globalIndex;
        });
        onFrameBatchesChange(newFrameBatches);
      }
    },
    [frameBatches, onFrameBatchesChange],
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

  const { containerRef, setColumnRef, columnIndicatorRef } =
    useAnimatedActiveColumnIndicator(currentStepIndex);

  return (
    <KeyframeMoveTogetherDndContext
      onDragEnd={handleDragEnd}
      sensors={sensors}
      modifiers={DND_CONTEXT_MODIFIERS}
    >
      <DragStateStyleDiv
        ref={containerRef}
        className={styles.timelineContainer}
        classNameWhenDragging={`${styles.timelineContainer} ${styles.dragging}`}
      >
        <div
          ref={columnIndicatorRef}
          className={styles.activeColumnIndicator}
        />
        <div className={styles.headerLessColumn}>
          <DroppableArea
            type="after"
            globalIndex={-1}
            className={styles.inbetweenDroppableCell}
          />
        </div>
        {steps.map((frameBatches, stepIdx) => {
          return (
            <React.Fragment key={frameBatches[0].id}>
              <div className={styles.column} ref={setColumnRef(stepIdx)}>
                <div className={styles.headerCell}>
                  <button
                    className={`${styles.frameButton} ${stepIdx === currentStepIndex ? styles.selected : ""}`}
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
                    const trackBatches = frameBatches.filter(
                      (b) => b.trackId === track.id,
                    );
                    return (
                      <div key={track.id} className={styles.frameBatchCell}>
                        {trackBatches.map((batch) => {
                          // NOTE: `trackBatches.length` is always 1, while we loop over it just in case.
                          const kf = batch.data[0];
                          return (
                            <DraggableKeyframeUI
                              key={kf.id}
                              kf={batch}
                              trackId={track.id}
                              localIndex={batch.localIndex}
                              className={styles.frameBatchControl}
                            >
                              <KeyframeEditPopover
                                keyframe={kf}
                                onUpdate={(newKeyframe) =>
                                  onKeyframeChange(newKeyframe)
                                }
                              >
                                <div>
                                  <FrameIcon
                                    isSelected={selectedFrameIds.includes(
                                      kf.id,
                                    )}
                                    onClick={() => {
                                      onFrameSelect(kf.id);
                                    }}
                                  >
                                    {kf.data.type === "cameraZoom"
                                      ? "🎞️"
                                      : batch.localIndex + 1}
                                  </FrameIcon>
                                </div>
                              </KeyframeEditPopover>

                              {batch.data
                                .slice(1)
                                .map((subFrame, subFrameIdx) => {
                                  return (
                                    <FrameIcon
                                      key={subFrame.id}
                                      isSelected={selectedFrameIds.includes(
                                        subFrame.id,
                                      )}
                                      subFrame
                                      onClick={() => {
                                        onFrameSelect(subFrame.id);
                                      }}
                                    >
                                      {subFrameIdx + 1}
                                    </FrameIcon>
                                  );
                                })}
                              <div className={styles.frameAddButtonContainer}>
                                <FrameIcon
                                  as="button"
                                  onClick={() => requestKeyframeAddAfter(kf)}
                                >
                                  +
                                </FrameIcon>
                              </div>
                            </DraggableKeyframeUI>
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
            </React.Fragment>
          );
        })}
        {showAttachKeyframeButton && (
          <div className={styles.column}>
            <div className={styles.headerCell}>{steps.length + 1}</div>
            {tracks.map((track) => (
              <div key={track.id} className={styles.keyframeCell}></div>
            ))}
            <div className={styles.keyframeCell}>
              <FrameIcon
                as="button"
                isSelected={true}
                onClick={() => requestAttachKeyframe()}
              >
                +
              </FrameIcon>
            </div>
          </div>
        )}
      </DragStateStyleDiv>
    </KeyframeMoveTogetherDndContext>
  );
}
