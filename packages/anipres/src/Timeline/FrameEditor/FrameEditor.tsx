import React, { useState } from "react";
import { Resizable } from "re-resizable";
import { Frame } from "../../models";
import { FrameEditPopover } from "./FrameEditPopover";
import styles from "./FrameEditor.module.scss";

const FRAME_BLOCK_WIDTH = 20;
const DURATION_PER_PIXEL = 20;
const MAX_DURATION_WIDTH = 100;

function Handle() {
  return <div className={styles.durationHandle} data-no-dnd="true"></div>;
}

export interface FrameEditorProps {
  frame: Frame;
  isPlaceholder: boolean;
  onUpdate: (newFrame: Frame) => void;
  isSelected: boolean;
  onClick: () => void;
}
export const FrameEditor = React.forwardRef<HTMLDivElement, FrameEditorProps>(
  (props, ref) => {
    const { frame, isPlaceholder, onUpdate, isSelected, onClick } = props;
    const { duration = 0, easing } = frame.action;

    const [editingDuration, setEditingDuration] = useState<number | null>(null);

    const displayDuration = editingDuration ?? duration;

    const displayDurationElemWidth = displayDuration / DURATION_PER_PIXEL;
    const isDisplayShrinking = displayDurationElemWidth > MAX_DURATION_WIDTH;

    const rawDurationWidth = duration / DURATION_PER_PIXEL;
    const durationElemWidth = Math.min(rawDurationWidth, MAX_DURATION_WIDTH);
    return (
      <FrameEditPopover frame={frame} onUpdate={onUpdate}>
        <div
          ref={ref}
          className={styles.container}
          onClick={onClick}
          data-selected={isSelected}
          data-placeholder={isPlaceholder}
        >
          <Resizable
            className={styles.editorContainer}
            enable={{ right: true }}
            size={{
              width: durationElemWidth + FRAME_BLOCK_WIDTH,
            }}
            minWidth={FRAME_BLOCK_WIDTH}
            handleComponent={{
              right: <Handle />,
            }}
            onResize={(_, __, ___, delta) => {
              setEditingDuration(
                durationElemWidth * DURATION_PER_PIXEL +
                  delta.width * DURATION_PER_PIXEL,
              );
            }}
            onResizeStop={(_, __, ___, delta) => {
              setEditingDuration(null);
              onUpdate({
                ...frame,
                action: {
                  ...frame.action,
                  duration:
                    durationElemWidth * DURATION_PER_PIXEL +
                    delta.width * DURATION_PER_PIXEL,
                },
              });
            }}
          >
            <div
              className={`${styles.durationDisplay} ${isDisplayShrinking ? styles.shrink : ""}`}
              title={
                `Duration: ${displayDuration}ms` +
                (easing ? `, Easing: ${easing}` : "")
              }
              style={{
                width: displayDurationElemWidth,
              }}
            >
              {displayDuration}
            </div>
            <div
              style={{ width: FRAME_BLOCK_WIDTH, minWidth: FRAME_BLOCK_WIDTH }}
              className={styles.frameBlock}
            />
          </Resizable>
        </div>
      </FrameEditPopover>
    );
  },
);

FrameEditor.displayName = "FrameEditor";
