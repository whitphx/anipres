import { describe, expect, it } from "vitest";
import { calcDraggableDOMDeltaXs } from "./frame-drag-deltas";

/**
 * Three frames of one track, 20px wide, with a 20px gap between them —
 * the gap being what lets a small drag stop short of its neighbour.
 */
const RECTS = {
  "T-1": [0, 40, 80].map(
    (left) => ({ left, right: left + 20, width: 20 }) as DOMRect,
  ),
};

function deltasOf(
  trackIndex: number,
  deltaX: number,
  pushesNeighbours: boolean,
) {
  return calcDraggableDOMDeltaXs(
    { trackId: "T-1", trackIndex, deltaX, pushesNeighbours },
    RECTS,
  )?.["T-1"];
}

describe("calcDraggableDOMDeltaXs", () => {
  // The preview of a drag across steps, which carries the frames on the
  // far side of the dragged one toward the destination.
  it("shoves the frames a drop would carry along", () => {
    expect(deltasOf(0, 25, true)).toEqual({ 0: 25, 1: 5 });
  });

  it("shoves them leftward too", () => {
    expect(deltasOf(2, -25, true)).toEqual({ 2: -25, 1: -5 });
  });

  it("stops shoving at the first frame the dragged one clears", () => {
    // 5px moves nothing into anything: every neighbour keeps its place.
    expect(deltasOf(0, 5, true)).toEqual({ 0: 5 });
  });

  // A reorder inside the batch moves exactly the dragged frame and
  // swaps it with the one it displaces. Shoving the neighbours would
  // show the order being preserved, which is the opposite of what the
  // drop does.
  it("moves only the dragged frame when the drop would reorder", () => {
    expect(deltasOf(0, 25, false)).toEqual({ 0: 25 });
  });

  it("moves only the dragged frame reordering leftward", () => {
    expect(deltasOf(2, -25, false)).toEqual({ 2: -25 });
  });

  it("has nothing to say about a drag that has not moved", () => {
    expect(deltasOf(0, 0, true)).toBeUndefined();
    expect(deltasOf(0, 0, false)).toBeUndefined();
  });

  it("ignores a track it never measured", () => {
    expect(
      calcDraggableDOMDeltaXs(
        {
          trackId: "T-absent",
          trackIndex: 0,
          deltaX: 25,
          pushesNeighbours: true,
        },
        RECTS,
      ),
    ).toBeNull();
  });
});
