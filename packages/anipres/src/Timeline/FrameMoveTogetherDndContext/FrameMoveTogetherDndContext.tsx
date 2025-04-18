import React, { useCallback, useMemo, useRef, useState } from "react";
import { DndContext, type DndContextProps } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  draggableFrameDOMContext,
  type DraggableFrameDOMContext,
} from "./draggableFrameDOMContext";

interface FrameDraggingState {
  trackId: string;
  trackIndex: number;
  deltaX: number;
}
type DraggableFrameDOMs = Record<string, (HTMLElement | null)[]>; // obj[trackId][trackIndex] = HTMLElement | null

const DND_CONTEXT_MODIFIERS = [restrictToHorizontalAxis];

export function FrameMoveTogetherDndContext({
  children,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  ...dndContextProps
}: {
  children: React.ReactNode;
} & DndContextProps) {
  const [draggingState, setDraggingState] = useState<FrameDraggingState | null>(
    null,
  );

  const handleDragMove = useCallback<
    NonNullable<DndContextProps["onDragMove"]>
  >(
    (event) => {
      const { active, delta } = event;
      const trackId = active.data.current?.trackId;
      const trackIndex = active.data.current?.trackIndex;
      if (typeof trackId === "string" && typeof trackIndex === "number") {
        setDraggingState({
          trackId,
          trackIndex,
          deltaX: delta.x,
        });
      }

      onDragMove?.(event);
    },
    [onDragMove],
  );

  const handleDragEnd = useCallback<NonNullable<DndContextProps["onDragEnd"]>>(
    (event) => {
      setDraggingState(null);
      onDragEnd?.(event);
    },
    [onDragEnd],
  );
  const handleDragCancel = useCallback<
    NonNullable<DndContextProps["onDragCancel"]>
  >(
    (event) => {
      setDraggingState(null);
      onDragCancel?.(event);
    },
    [onDragCancel],
  );

  const draggableDOMsRef = useRef<DraggableFrameDOMs>({});
  const registerDOM = useCallback<DraggableFrameDOMContext["registerDOM"]>(
    (trackId, trackIndex, node) => {
      const draggableDOMs = draggableDOMsRef.current;
      if (!draggableDOMs[trackId]) {
        draggableDOMs[trackId] = Array(trackIndex + 1).fill(null);
      } else if (draggableDOMs[trackId].length < trackIndex + 1) {
        draggableDOMs[trackId] = [
          ...draggableDOMs[trackId],
          ...Array(trackIndex + 1 - draggableDOMs[trackId].length).fill(null),
        ];
      }
      draggableDOMs[trackId][trackIndex] = node;
      draggableDOMsRef.current = draggableDOMs;
    },
    [],
  );

  const draggableDOMOrgRectsRef = useRef<Record<string, (DOMRect | null)[]>>(
    {},
  );
  const initializeDOMRects = useCallback(() => {
    const draggableDOMs = draggableDOMsRef.current;
    const draggableDOMOrgRects: Record<string, (DOMRect | null)[]> = {};
    for (const trackId in draggableDOMs) {
      draggableDOMOrgRects[trackId] = draggableDOMs[trackId].map((dom) => {
        if (dom == null) {
          return null;
        }
        return dom.getBoundingClientRect();
      });
    }
    draggableDOMOrgRectsRef.current = draggableDOMOrgRects;
  }, []);
  const handleDragStart = useCallback<
    NonNullable<DndContextProps["onDragStart"]>
  >(
    (...args) => {
      initializeDOMRects();
      onDragStart?.(...args);
    },
    [initializeDOMRects, onDragStart],
  );

  const draggableDOMDeltaXs = useMemo(() => {
    if (draggingState == null) {
      return null;
    }
    const { trackId, trackIndex, deltaX: delta } = draggingState;

    const draggableDOMOrgRects = draggableDOMOrgRectsRef.current;
    const rectsInTrack = draggableDOMOrgRects[trackId];
    if (rectsInTrack == null) {
      return null;
    }

    const selfRect = rectsInTrack[trackIndex];
    if (selfRect == null) {
      return null;
    }

    if (delta > 0) {
      const draggableDOMDeltaXs: Record<number, number> = {};
      // Dragging right
      let right = selfRect.right + delta;
      for (let i = trackIndex + 1; i < rectsInTrack.length; i++) {
        const domRect = rectsInTrack[i];
        if (domRect == null) continue;
        if (domRect.left < right) {
          const delta = right - domRect.left;
          draggableDOMDeltaXs[i] = delta;
          right = right + domRect.width;
        } else {
          break;
        }
      }
      return { [trackId]: draggableDOMDeltaXs };
    } else if (delta < 0) {
      // Dragging left
      const draggableDOMDeltaXs: Record<number, number> = {};
      let left = selfRect.left + delta;
      for (let i = trackIndex - 1; i >= 0; i--) {
        const domRect = rectsInTrack[i];
        if (domRect == null) continue;
        if (left < domRect.right) {
          const delta = left - domRect.right;
          draggableDOMDeltaXs[i] = delta;
          left = left - domRect.width;
        } else {
          break;
        }
      }
      return { [trackId]: draggableDOMDeltaXs };
    }

    return null;
  }, [draggingState]);

  return (
    <draggableFrameDOMContext.Provider
      value={{
        registerDOM,
        draggableDOMDeltaXs,
      }}
    >
      <DndContext
        {...dndContextProps}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        modifiers={DND_CONTEXT_MODIFIERS}
      >
        {children}
      </DndContext>
    </draggableFrameDOMContext.Provider>
  );
}
