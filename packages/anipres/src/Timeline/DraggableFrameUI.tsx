import React, { useCallback, useMemo } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useDraggableFrameDelta } from "./FrameMoveTogetherDndContext";
import type { FrameUIData } from "./frame-ui-data";

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
    const { setNodeRef: setDropNodeRef } = useDroppable({
      id: `within-${frame.shapeId}`,
      disabled: !reorderTarget,
      data: useMemo(
        () => ({ type: "within" as const, batchId, trackId, trackIndex }),
        [batchId, trackId, trackIndex],
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
        className={className}
      >
        {children}
      </div>
    );
  },
);
DraggableFrameUI.displayName = "DraggableFrameUI";
