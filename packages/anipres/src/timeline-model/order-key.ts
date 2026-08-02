// Fractional order keys, wrapped behind this module so nothing else in
// the codebase imports the underlying library.
//
// Implementation: Rocicorp's `fractional-indexing`
// (https://github.com/rocicorp/fractional-indexing), the reference
// implementation of the scheme. The previously used
// `fractional-indexing-jittered` can emit invalid keys with trailing
// zeroes (https://github.com/TMeerhof/fractional-indexing-jittered/issues/6),
// and jitter buys nothing here: the ordering these keys carry tolerates
// equal keys by design (identity lives in ids, and collision runs are
// normalized), so a rare duplicate costs a bounded re-key rather than
// correctness. If jitter is ever wanted, swap the implementation inside
// this module — callers only see `OrderKey` and the operations below.
//
// Keys are compared as plain code units (`<`/`>`), never
// `localeCompare`: locale collation mis-sorts the capital-prefixed
// keys generated before the first item and varies with the ICU locale.
// Equal keys are legal (identity lives in ids, never in keys), so every
// sort over keyed objects must tie-break on the object's stable unique
// id to stay deterministic.

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** A fractional order key. Persists as a plain JSON string. */
export type OrderKey = string;

/** A key strictly between a and b (null = open end). */
export function orderKeyBetween(
  a: OrderKey | null,
  b: OrderKey | null,
): OrderKey {
  return generateKeyBetween(a, b);
}

/**
 * n keys strictly between a and b (null = open end), strictly
 * ascending. Preferred over n repeated `orderKeyBetween` calls for
 * adjacent inserts: the keys are spread instead of nested, so they stay
 * short.
 */
export function orderKeysBetween(
  a: OrderKey | null,
  b: OrderKey | null,
  n: number,
): OrderKey[] {
  return generateNKeysBetween(a, b, n);
}

export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Migration keys — a pure function of the coordinates (globalIndex,
// partitionIndex). The output depends on nothing but its arguments: in
// particular, not on which other records are currently v1 or v2.
//
// Construction (spec "Option A"): f(gi) is the gi-th key of the iterated
// key-above chain from the initial key; partition p > 0 is the p-th key of
// the iterated key-between chain nested strictly inside (f(gi), f(gi+1)),
// so (globalIndex, partition) order is preserved.
// ---------------------------------------------------------------------------

const integerKeyCache: OrderKey[] = [];

function integerKey(globalIndex: number): OrderKey {
  if (!Number.isInteger(globalIndex) || globalIndex < 0) {
    throw new Error(`Invalid globalIndex: ${globalIndex}`);
  }
  while (integerKeyCache.length <= globalIndex) {
    const prev = integerKeyCache.at(-1) ?? null;
    integerKeyCache.push(generateKeyBetween(prev, null));
  }
  return integerKeyCache[globalIndex];
}

/**
 * The i-th key of a migrated sub-frame chain — the same iterated key-above
 * chain as the integer step keys ("a0", "a1", …), coordinate-pure. Exposed
 * so migration can RESERVE the indices already persisted by an interrupted
 * run and assign the remaining sub frames the next free indices, making
 * sub-chain resume byte-identical to a complete migration.
 */
export function getMigratedSubFrameOrderKey(index: number): OrderKey {
  return integerKey(index);
}

const partitionKeyCache = new Map<string, OrderKey>();

export function getMigratedStepOrderKey(
  globalIndex: number,
  partitionIndex: number,
): OrderKey {
  if (!Number.isInteger(partitionIndex) || partitionIndex < 0) {
    throw new Error(`Invalid partitionIndex: ${partitionIndex}`);
  }
  if (partitionIndex === 0) {
    return integerKey(globalIndex);
  }
  const cacheKey = `${globalIndex}:${partitionIndex}`;
  const cached = partitionKeyCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }
  const upperBound = integerKey(globalIndex + 1);
  let key = integerKey(globalIndex);
  for (let p = 1; p <= partitionIndex; p++) {
    const stepCacheKey = `${globalIndex}:${p}`;
    const stepCached = partitionKeyCache.get(stepCacheKey);
    if (stepCached != null) {
      key = stepCached;
    } else {
      key = generateKeyBetween(key, upperBound);
      partitionKeyCache.set(stepCacheKey, key);
    }
  }
  return key;
}
