export interface OrderedTrackItem<T = unknown> {
  id: string;
  globalIndex: number;
  trackId: string;
  data: T;
}

// A group of items with the same globalIndex.
export type ItemGroup<T> = OrderedTrackItem<T>[];

/**
 * getGlobalOrder:
 * Sorts the items by `globalIndex` and groups items sharing the same
 * `globalIndex` into one group. Throws if two items in the same track have
 * the same `globalIndex`.
 *
 * NOTE: This used to build a DAG and run a topological sort, but the two
 * edge types it added (same-track ascending index, global ascending index)
 * are respectively a strict subset of, and identical to, plain
 * `globalIndex` ordering — so the DAG encoded no information beyond
 * "sort by globalIndex, group equal values", and cycles were impossible by
 * construction. The only detectable conflict is the same-track/same-index
 * case, which is checked explicitly. See
 * docs/design-animation-data-model.md ("Problems with the v1 Encoding").
 */
export function getGlobalOrder<T>(
  items: OrderedTrackItem<T>[],
): ItemGroup<T>[] {
  const copy = items.map((item) => ({ ...item }));
  copy.sort((a, b) => a.globalIndex - b.globalIndex);

  // Conflict detection: same trackId + same globalIndex is invalid.
  const seenTrackIndexPairs = new Map<string, OrderedTrackItem<T>>();
  for (const item of copy) {
    const key = `${item.globalIndex}:${item.trackId}`;
    const conflicting = seenTrackIndexPairs.get(key);
    if (conflicting != null) {
      throw new Error(
        `Cycle or conflict: same trackId and globalIndex ${conflicting.id} and ${item.id} (${conflicting.globalIndex}, ${conflicting.trackId}) and (${item.globalIndex}, ${item.trackId})`,
      );
    }
    seenTrackIndexPairs.set(key, item);
  }

  const result: ItemGroup<T>[] = [];
  let currentGroup: ItemGroup<T> | null = null;
  let currentIndex: number | null = null;
  for (const item of copy) {
    if (currentGroup == null || item.globalIndex !== currentIndex) {
      currentGroup = [];
      result.push(currentGroup);
      currentIndex = item.globalIndex;
    }
    currentGroup.push(item);
  }
  return result;
}

export function reassignGlobalIndexInplace<T>(globalOrder: ItemGroup<T>[]) {
  let gIndex = 0;
  for (const group of globalOrder) {
    if (group.length === 0) continue;
    for (const item of group) {
      item.globalIndex = gIndex;
    }
    gIndex++;
  }
}

export function insertOrderedTrackItem<T>(
  items: OrderedTrackItem<T>[],
  newItem: OrderedTrackItem<T>,
  globalIndex: number,
): OrderedTrackItem<T>[] {
  const globalOrder = getGlobalOrder(items);

  const newGlobalOrder = [
    ...globalOrder.slice(0, globalIndex),
    [newItem],
    ...globalOrder.slice(globalIndex),
  ];
  reassignGlobalIndexInplace(newGlobalOrder);
  return newGlobalOrder.flat();
}
