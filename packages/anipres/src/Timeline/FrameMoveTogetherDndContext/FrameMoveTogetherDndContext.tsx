import React, { useCallback, useRef, useState, useMemo } from "react";
import { DndContext, type DndContextProps } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  draggableFrameDOMContext,
  type DraggableFrameDOMContext,
} from "./draggableFrameDOMContext";
import { calcDraggableDOMDeltaXs } from "./frame-drag-deltas";

type DraggableFrameDOMs = Record<string, (HTMLElement | null)[]>; // obj[trackId][trackIndex] = HTMLElement | null

const DND_CONTEXT_MODIFIERS = [restrictToHorizontalAxis];

export const FrameMoveTogetherDndContext = React.memo(
  ({
    children,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    ...dndContextProps
  }: React.PropsWithChildren<DndContextProps>) => {
    const [draggableDOMDeltaXs, setDraggableDOMDeltaXs] = useState<Record<
      string,
      Record<number, number>
    > | null>(null);
    const [draggableDOMOrgRects, setDraggableDOMOrgRects] = useState<
      Record<string, (DOMRect | null)[]>
    >({});

    const handleDragMove = useCallback<
      NonNullable<DndContextProps["onDragMove"]>
    >(
      (event) => {
        const { active, over, delta } = event;
        const trackId = active.data.current?.trackId;
        const trackIndex = active.data.current?.trackIndex;
        if (typeof trackId === "string" && typeof trackIndex === "number") {
          const draggingState = {
            trackId,
            trackIndex,
            deltaX: delta.x,
            pushesNeighbours: over?.data.current?.type !== "within",
          };
          setDraggableDOMDeltaXs(
            calcDraggableDOMDeltaXs(draggingState, draggableDOMOrgRects),
          );
        }

        onDragMove?.(event);
      },
      [onDragMove, draggableDOMOrgRects],
    );

    const handleDragEnd = useCallback<
      NonNullable<DndContextProps["onDragEnd"]>
    >(
      (event) => {
        setDraggableDOMDeltaXs(null);
        onDragEnd?.(event);
      },
      [onDragEnd],
    );
    const handleDragCancel = useCallback<
      NonNullable<DndContextProps["onDragCancel"]>
    >(
      (event) => {
        setDraggableDOMDeltaXs(null);
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
      setDraggableDOMOrgRects(draggableDOMOrgRects);
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

    const value = useMemo(
      () => ({
        registerDOM,
        draggableDOMDeltaXs,
      }),
      [registerDOM, draggableDOMDeltaXs],
    );

    return (
      <draggableFrameDOMContext.Provider value={value}>
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
  },
);
FrameMoveTogetherDndContext.displayName = "FrameMoveTogetherDndContext";
