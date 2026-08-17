import { describe, it, expect } from "vitest";
import type {
  Collision,
  CollisionDetection,
  DroppableContainer,
} from "@dnd-kit/core";
import { createFrameCollisionDetection } from "./frame-collision";

type Data = Record<string, unknown>;

function container(id: string, data: Data): DroppableContainer {
  return { id, data: { current: data } } as unknown as DroppableContainer;
}

/**
 * Stands in for dnd-kit's rect scoring: reports a collision for every
 * candidate named in `ranking`, in that order, skipping any the filter
 * removed. The corrections under test are about which candidates exist
 * and which of the winners is honoured, never about the geometry.
 */
function intersectRanked(ranking: string[]): CollisionDetection {
  return ({ droppableContainers }) => {
    const byId = new Map(droppableContainers.map((c) => [String(c.id), c]));
    return ranking.flatMap((id): Collision[] => {
      const droppableContainer = byId.get(id);
      return droppableContainer == null
        ? []
        : [{ id, data: { droppableContainer, value: 1 } }];
    });
  };
}

const OWN_BATCH = "batch-1";
const OTHER_BATCH = "batch-2";

const CONTAINERS = [
  container("at-0", { type: "at", globalIndex: 0 }),
  container("after-0", { type: "after", globalIndex: 0 }),
  // The dragged frame's own place, and its neighbour in the same batch.
  container("within-self", {
    type: "within",
    batchId: OWN_BATCH,
    trackIndex: 1,
  }),
  container("within-neighbour", {
    type: "within",
    batchId: OWN_BATCH,
    trackIndex: 2,
  }),
  // Another batch's frame, which happens to carry the same trackIndex
  // as the dragged frame — tracks number their frames independently.
  container("within-foreign", {
    type: "within",
    batchId: OTHER_BATCH,
    trackIndex: 1,
  }),
];

function detect(ranking: string[]): string[] {
  const detection = createFrameCollisionDetection(intersectRanked(ranking));
  return detection({
    active: {
      id: "dragged",
      data: { current: { batchId: OWN_BATCH, trackIndex: 1 } },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: {} as never,
    droppableRects: new Map(),
    droppableContainers: CONTAINERS,
    pointerCoordinates: null,
  } as never).map((collision) => String(collision.id));
}

describe("createFrameCollisionDetection", () => {
  it("drops another batch's places, so a drop there still means its step", () => {
    // The merge that puts an event in front of a movement depends on
    // this: the foreign frame must resolve to the step it sits in.
    expect(detect(["within-foreign", "at-0"])).toEqual(["at-0"]);
  });

  it("keeps a neighbour's place in the frame's own batch", () => {
    expect(detect(["within-neighbour", "at-0"])).toEqual([
      "within-neighbour",
      "at-0",
    ]);
  });

  it("stands aside while the frame is still over its own place", () => {
    // Otherwise a sliver of overlap with a neighbour would shadow the
    // between-steps drop zone that moves the frame out of the batch.
    expect(detect(["within-self", "within-neighbour", "after-0"])).toEqual([
      "after-0",
    ]);
  });

  it("answers with the neighbour once it outranks the frame's own place", () => {
    expect(detect(["within-neighbour", "within-self", "after-0"])).toEqual([
      "within-neighbour",
      "within-self",
      "after-0",
    ]);
  });

  it("leaves a drag with no places to consider exactly as it was", () => {
    expect(detect(["at-0", "after-0"])).toEqual(["at-0", "after-0"]);
  });
});
