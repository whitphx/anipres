import { rectIntersection, type CollisionDetection } from "@dnd-kit/core";

/**
 * A frame's place within its batch is the timeline's first droppable
 * nested inside another (the step column it sits in), so the default
 * rect intersection needs two corrections. Everything else — which rect
 * beats which — is dnd-kit's own scoring, unchanged.
 *
 * Injectable `intersect` so the corrections can be tested without
 * laying out real rects.
 */
export function createFrameCollisionDetection(
  intersect: CollisionDetection = rectIntersection,
): CollisionDetection {
  return (args) => {
    const activeBatchId = args.active.data.current?.batchId;
    const srcTrackIndex = args.active.data.current?.trackIndex;
    const collisions = intersect({
      ...args,
      // A batch's places belong to its own frames. Without this, a drop
      // onto ANOTHER batch's frame could resolve to that frame's place
      // instead of its step, silently killing the merge that puts an
      // event in front of a movement.
      droppableContainers: args.droppableContainers.filter(
        (container) =>
          container.data.current?.type !== "within" ||
          container.data.current?.batchId === activeBatchId,
      ),
    });
    // Only the active batch's places survive the filter, and within one
    // batch no two frames share a trackIndex, so this cannot match a
    // frame of another batch that happens to carry the same index.
    const placeTrackIndexOf = (collision: (typeof collisions)[number]) =>
      collision.data?.droppableContainer?.data?.current?.type === "within"
        ? (collision.data.droppableContainer.data.current.trackIndex as number)
        : null;
    const [top] = collisions;
    if (top != null && placeTrackIndexOf(top) === srcTrackIndex) {
      // Still mostly over its own place: the pointer has not travelled
      // far enough to mean a reorder, so let the step-level targets
      // answer — otherwise a sliver of overlap with a neighbour would
      // shadow the drop zone between steps, which moves the frame out
      // of its batch.
      return collisions.filter(
        (collision) => placeTrackIndexOf(collision) == null,
      );
    }
    return collisions;
  };
}
