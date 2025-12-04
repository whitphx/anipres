import React from "react";
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
    const { attributes, listeners, setNodeRef, isDragging, active } =
      useDraggable({
        id,
        data: {
          trackId,
          trackIndex,
          globalIndex,
          frame,
        },
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
        ref={(node) => {
          setNodeRef(node);
          registerDOM(node);
        }}
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
