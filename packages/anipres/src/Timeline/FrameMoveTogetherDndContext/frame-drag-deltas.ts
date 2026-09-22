export interface FrameDraggingState {
  trackId: string;
  trackIndex: number;
  deltaX: number;
  /**
   * Whether the drop currently under the pointer would carry the frames
   * beside this one along with it, which decides whether they are shown
   * moving. A drag across steps pushes the frames on the far side of
   * the dragged one toward the destination, so they do travel with it.
   * A reorder inside the batch moves exactly the dragged frame and
   * swaps it with the one whose place it takes, so shoving the
   * neighbours there would promise a rearrangement that never happens —
   * and it is a media event, which the batch exists to order against a
   * movement, that a user reorders this way.
   */
  pushesNeighbours: boolean;
}

/**
 * How far each frame of the dragged frame's track should appear to
 * move. Keyed by trackIndex, and the dragged frame is always in it:
 * these deltas position it too, rather than dnd-kit's own transform.
 */
export function calcDraggableDOMDeltaXs(
  draggingState: FrameDraggingState,
  draggableDOMOrgRects: Record<string, (DOMRect | null)[]>,
): Record<string, Record<number, number>> | null {
  const {
    trackId,
    trackIndex,
    deltaX: delta,
    pushesNeighbours,
  } = draggingState;

  const rectsInTrack = draggableDOMOrgRects[trackId];
  if (rectsInTrack == null) {
    return null;
  }

  const selfRect = rectsInTrack[trackIndex];
  if (selfRect == null) {
    return null;
  }

  if (delta === 0) {
    return null;
  }

  const draggableDOMDeltaXs: Record<number, number> = {};
  draggableDOMDeltaXs[trackIndex] = delta;
  if (!pushesNeighbours) {
    return { [trackId]: draggableDOMDeltaXs };
  }
  if (delta > 0) {
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
  }
  // Dragging left
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
