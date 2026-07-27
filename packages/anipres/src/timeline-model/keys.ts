// Fractional order-key helpers.
//
// We depend on `fractional-indexing-jittered` directly — the same
// implementation tldraw's own index keys use (so key formats are
// byte-compatible with tldraw z-order keys) — instead of tldraw's
// `getIndexBetween` helpers, because those switch to deterministic
// generation under NODE_ENV=test, which would be a determinism trap for
// migration keys (they must be deterministic in EVERY environment).
//
// Policy (spec: docs/design-animation-data-model.md):
// - Interactive key generation uses the JITTERED variants: identity is
//   carried by `stepId`, never by key equality, so jitter is a pure
//   collision-frequency optimization.
// - Migration keys use the DETERMINISTIC variants only.

import {
  generateJitteredKeyBetween,
  generateKeyBetween,
  generateNKeysBetween,
} from "fractional-indexing-jittered";

/** Interactive: a key strictly between a and b (null = open end). */
export function interactiveKeyBetween(
  a: string | null,
  b: string | null,
): string {
  return generateJitteredKeyBetween(a, b);
}

/** Interactive: a key strictly above a (or an initial key if a is null). */
export function interactiveKeyAbove(a: string | null): string {
  return generateJitteredKeyBetween(a, null);
}

/** Deterministic: n keys strictly between a and b (null = open end). */
export function deterministicKeysBetween(
  a: string | null,
  b: string | null,
  n: number,
): string[] {
  return generateNKeysBetween(a, b, n);
}

export function compareOrderKeys(a: string, b: string): number {
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

const integerKeyCache: string[] = [];

function integerKey(globalIndex: number): string {
  if (!Number.isInteger(globalIndex) || globalIndex < 0) {
    throw new Error(`Invalid globalIndex: ${globalIndex}`);
  }
  while (integerKeyCache.length <= globalIndex) {
    const prev = integerKeyCache.at(-1) ?? null;
    integerKeyCache.push(generateKeyBetween(prev, null));
  }
  return integerKeyCache[globalIndex];
}

const partitionKeyCache = new Map<string, string>();

export function getMigratedStepOrderKey(
  globalIndex: number,
  partitionIndex: number,
): string {
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
