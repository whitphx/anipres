import React, { useCallback, useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useDraggableFrameDelta } from "./FrameMoveTogetherDndContext";
import { Frame } from "../models";

export const DraggableFrameUI = React.memo(
  ({
    id,
    trackId,
    trackIndex,
    globalIndex,
    frame,
    children,
    className,
  }: {
    id: string;
    trackId: string;
    trackIndex: number;
    globalIndex: number;
    frame: Frame;
    children: React.ReactNode;
    className?: string;
  }) => {
    const draggableData = useMemo(
      () => ({
        trackId,
        trackIndex,
        globalIndex,
        frame,
      }),
      [trackId, trackIndex, globalIndex, frame],
    );
    const { attributes, listeners, setNodeRef, isDragging, active } =
      useDraggable({
        id,
        data: draggableData,
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
            registerDOM(node);
          },
          [setNodeRef, registerDOM],
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
