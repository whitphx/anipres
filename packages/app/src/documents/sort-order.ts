import { generateKeyBetween } from "fractional-indexing";
import type { DocumentMeta } from "./types";

/**
 * Compute the fractional-indexing key that places a new doc at the
 * end of `existing`. `existing` is sorted by `sortOrder`
 * lexicographically and the new key is bumped past the tail.
 *
 * If `existing` is empty, falls back to the package's "first" key
 * (typically `"a0"`) via `generateKeyBetween(null, null)`.
 *
 * Known limitation: when two callers race on the same `existing`
 * snapshot they pick the same key. `generateKeyBetween` is
 * deterministic per (prev, next) pair, so the collision is silent —
 * the sidebar's stable sort still shows both, just in a
 * non-deterministic order between them, and any user reorder heals it.
 */
export function nextTailSortOrder(
  existing: ReadonlyArray<Pick<DocumentMeta, "sortOrder">>,
): string {
  const keys = existing
    .map((d) => d.sortOrder)
    .filter((key): key is string => typeof key === "string")
    .sort();
  const tail = keys[keys.length - 1] ?? null;
  return generateKeyBetween(tail, null);
}
