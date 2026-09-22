import React, { useCallback, useRef, useState, useMemo } from "react";
import {
  DndContext,
  type DndContextProps,
  type DragMoveEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  draggableFrameDOMContext,
  type DraggableFrameDOMContext,
} from "./draggableFrameDOMContext";
import { calcDraggableDOMDeltaXs } from "./frame-drag-deltas";
import { WITHIN_DROP_TYPE } from "../droppable-data";

type DraggableFrameDOMs = Record<string, (HTMLElement | null)[]>; // obj[trackId][trackIndex] = HTMLElement | null

const DND_CONTEXT_MODIFIERS = [restrictToHorizontalAxis];

export const FrameMoveTogetherDndContext = React.memo(
  ({
    children,
    onDragStart,
    onDragMove,
    onDragOver,
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

    const showDrag = useCallback(
      (event: DragMoveEvent | DragOverEvent) => {
        const { active, over, delta } = event;
        const trackId = active.data.current?.trackId;
        const trackIndex = active.data.current?.trackIndex;
        if (typeof trackId !== "string" || typeof trackIndex !== "number") {
          return;
        }
        setDraggableDOMDeltaXs(
          calcDraggableDOMDeltaXs(
            {
              trackId,
              trackIndex,
              deltaX: delta.x,
              pushesNeighbours: over?.data.current?.type !== WITHIN_DROP_TYPE,
            },
            draggableDOMOrgRects,
          ),
        );
      },
      [draggableDOMOrgRects],
    );

    const handleDragMove = useCallback<
      NonNullable<DndContextProps["onDragMove"]>
    >(
      (event) => {
        showDrag(event);
        onDragMove?.(event);
      },
      [showDrag, onDragMove],
    );
    // Also on drag OVER, because `over` is one render behind inside
    // `onDragMove`: dnd-kit sets it in an effect that runs after the one
    // firing this callback, so the move that crosses onto a frame's
    // place still reports the target it left. `onDragOver` fires on
    // exactly that crossing, carrying the new target. Without it a
    // keyboard drag would preview the wrong thing for the whole gap
    // between two arrow presses.
    const handleDragOver = useCallback<
      NonNullable<DndContextProps["onDragOver"]>
    >(
      (event) => {
        showDrag(event);
        onDragOver?.(event);
      },
      [showDrag, onDragOver],
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
          onDragOver={handleDragOver}
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
