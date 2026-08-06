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
