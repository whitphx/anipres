import React, { useCallback, useMemo } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useDraggableFrameDelta } from "./FrameMoveTogetherDndContext";
import type { FrameUIData } from "./frame-ui-data";
import styles from "./Timeline.module.scss";

export const DraggableFrameUI = React.memo(
  ({
    id,
    batchId,
    trackId,
    trackIndex,
    globalIndex,
    frame,
    reorderTarget,
    children,
    className,
  }: {
    id: string;
    batchId: string;
    trackId: string;
    trackIndex: number;
    globalIndex: number;
    frame: FrameUIData;
    /** Whether the frame's place can receive a reorder within its batch. */
    reorderTarget: boolean;
    children: React.ReactNode;
    className?: string;
  }) => {
    const draggableData = useMemo(
      () => ({
        batchId,
        trackId,
        trackIndex,
        globalIndex,
        frame,
      }),
      [batchId, trackId, trackIndex, globalIndex, frame],
    );
    const { attributes, listeners, setNodeRef, isDragging, active } =
      useDraggable({
        id,
        data: draggableData,
      });
    // The frame's own place, as a drop target: the same node, the way
    // dnd-kit's sortable does it. A separate gap element between frames
    // would change the batch's layout, and so the rects dnd-kit measures
    // at drag start.
    const { setNodeRef: setDropNodeRef, isOver } = useDroppable({
      id: `within-${frame.shapeId}`,
      disabled: !reorderTarget,
      data: useMemo(
        () => ({ type: "within" as const, batchId, trackIndex }),
        [batchId, trackIndex],
      ),
    });
    const { registerDOM, deltaX } = useDraggableFrameDelta(trackId, trackIndex);
    const transformX = deltaX ?? 0;
    const transformY = 0;
    const isDraggingSomething = active != null;
    const style: React.CSSProperties = {
      transform: `translate(${transformX}px, ${transformY}px)`,
      transition: isDraggingSomething ? undefined : "transform 0.3s",
      cursor: isDragging ? "grabbing" : "grab",
    };

    return (
      <div
        ref={useCallback(
          (node: HTMLDivElement | null) => {
            setNodeRef(node);
            setDropNodeRef(node);
            registerDOM(node);
          },
          [setNodeRef, setDropNodeRef, registerDOM],
        )}
        {...attributes}
        {...listeners}
        style={style}
        // The step column's own highlight goes out the moment a frame's
        // place wins the collision, so the place has to say it is the
        // target — and the sibling frames' shove is not that: it plays
        // for any drag along the track, wherever the drop would land.
        className={`${className ?? ""} ${isOver ? styles.reorderTarget : ""}`}
      >
        {children}
      </div>
    );
  },
);
DraggableFrameUI.displayName = "DraggableFrameUI";
