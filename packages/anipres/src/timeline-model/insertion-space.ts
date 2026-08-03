// Collision-run normalization — inserting between equal fractional keys.
// Spec: docs/design-animation-data-model.md — "Inserting between equal
// keys (collision runs)".
//
// Distinct stepIds keep concurrently inserted steps separate, but equal
// keys make `keyBetween(k, k)` undefined. This operation re-keys the local
// equal-key run (only the run — never the rest of the deck) in its current
// deterministic order, which provably does not change the derived timeline
// — so it executes inline in the insert transaction, not in any repair
// pass.
//
// All key generation is deterministic (see order-key.ts): two clients
// normalizing the same run produce identical writes and converge under
// last-writer-wins.

import { orderKeyBetween, orderKeysBetween } from "./order-key";

export interface OrderedKeyedItem {
  id: string;
  key: string;
}

export interface InsertionSpace {
  /** Existing items that must be re-keyed (only within the collision run). */
  updates: { id: string; key: string }[];
  /** The key for the newly inserted item. */
  insertedKey: string;
}

/**
 * Computes a key for inserting a new item at `insertionIndex` into
 * `orderedItems` (already in display order), re-keying an equal-key run
 * around the insertion point if one exists.
 */
export function makeInsertionSpace(
  orderedItems: OrderedKeyedItem[],
  insertionIndex: number,
): InsertionSpace {
  if (insertionIndex < 0 || insertionIndex > orderedItems.length) {
    throw new Error(`insertionIndex out of range: ${insertionIndex}`);
  }
  const below = orderedItems[insertionIndex - 1] ?? null;
  const above = orderedItems[insertionIndex] ?? null;

  if (below == null || above == null || below.key !== above.key) {
    const insertedKey = orderKeyBetween(below?.key ?? null, above?.key ?? null);
    return { updates: [], insertedKey };
  }

  // Equal-key run: find its bounds — the nearest strictly smaller and
  // strictly larger keys around the run.
  const runKey = below.key;
  let runStart = insertionIndex - 1;
  while (runStart > 0 && orderedItems[runStart - 1].key === runKey) {
    runStart--;
  }
  let runEnd = insertionIndex; // inclusive index of last run member ≥ this
  while (
    runEnd + 1 < orderedItems.length &&
    orderedItems[runEnd + 1].key === runKey
  ) {
    runEnd++;
  }
  const lowerBound = orderedItems[runStart - 1]?.key ?? null;
  const upperBound = orderedItems[runEnd + 1]?.key ?? null;

  const runItems = orderedItems.slice(runStart, runEnd + 1);
  const newKeys = orderKeysBetween(lowerBound, upperBound, runItems.length + 1);

  const updates: { id: string; key: string }[] = [];
  let insertedKey = "";
  let keyIndex = 0;
  for (let i = runStart; i <= runEnd + 1; i++) {
    if (i === insertionIndex) {
      insertedKey = newKeys[keyIndex++];
    }
    if (i <= runEnd) {
      const item = orderedItems[i];
      const newKey = newKeys[keyIndex++];
      if (newKey !== item.key) {
        updates.push({ id: item.id, key: newKey });
      }
    }
  }

  return { updates, insertedKey };
}
