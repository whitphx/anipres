// Identity helpers for the v2 timeline model.
// Spec: docs/design-animation-data-model.md — "Derived TimelineDoc" and
// "Migration from v1" (Determinism).

/**
 * Reserved prefix for derived (rule-2 synthetic) step ids. Persisted
 * `stepId`s must never use it — the frame parser diagnoses those as
 * invalid input, and duplication preprocessing freshens them.
 */
export const SYNTHETIC_STEP_PREFIX = "synthstep:";

/**
 * Derived id for a rule-2 recovery step. JSON tuple encoding is required
 * for injectivity: naive ":"-joining is not collision-free because the
 * components may themselves contain ":" (`v1step:` source ids always do),
 * so ("a:b", "c") and ("a", "b:c") would concatenate identically.
 *
 * NOT a parse contract — the structured `StepData.synthetic` field is the
 * source of truth; this id only needs to be deterministic, stable while
 * the source frames are unchanged, and injective over its inputs.
 */
export function makeSyntheticStepId(
  sourceStepId: string,
  cueShapeId: string,
): string {
  return `${SYNTHETIC_STEP_PREFIX}${JSON.stringify([sourceStepId, cueShapeId])}`;
}

export function isReservedStepId(stepId: string): boolean {
  return stepId.startsWith(SYNTHETIC_STEP_PREFIX);
}

/**
 * Namespace for deterministic migration step ids. Unlike `synthstep:`,
 * this format IS a parse contract: mixed-document group reconstruction
 * recovers `(globalIndex, partitionIndex)` coordinates from it.
 */
export const V1_STEP_PREFIX = "v1step:";

/**
 * Upper bound for migration coordinates (v1 `globalIndex`, partition
 * index). The coordinate-pure key functions iterate and CACHE one key per
 * index, so an unbounded value from corrupted or hostile persisted data
 * (e.g. `globalIndex: 1e9`) would hang migration at load time and retain
 * that many strings. Real decks have orders of magnitude fewer steps;
 * out-of-range records are classified invalid / non-migrated instead.
 */
export const MAX_MIGRATION_COORDINATE = 100_000;

export function makeMigratedStepId(
  pageId: string,
  globalIndex: number,
  partitionIndex: number,
): string {
  return `${V1_STEP_PREFIX}${pageId}:${globalIndex}:${partitionIndex}`;
}

export interface MigratedStepCoordinates {
  pageId: string;
  globalIndex: number;
  partitionIndex: number;
}

/**
 * Parses a `v1step:` id back to its coordinates, or returns null if the id
 * does not follow the contract. tldraw page ids themselves contain ":"
 * ("page:xyz"), so parsing takes the two *trailing* integer segments
 * rather than splitting naively.
 */
export function parseMigratedStepId(
  stepId: string,
): MigratedStepCoordinates | null {
  if (!stepId.startsWith(V1_STEP_PREFIX)) {
    return null;
  }
  const body = stepId.slice(V1_STEP_PREFIX.length);
  const segments = body.split(":");
  if (segments.length < 3) {
    return null;
  }
  const partitionSegment = segments[segments.length - 1];
  const globalIndexSegment = segments[segments.length - 2];
  if (!/^\d+$/.test(partitionSegment) || !/^\d+$/.test(globalIndexSegment)) {
    return null;
  }
  const pageId = segments.slice(0, -2).join(":");
  if (pageId.length === 0) {
    return null;
  }
  const globalIndex = Number(globalIndexSegment);
  const partitionIndex = Number(partitionSegment);
  if (
    globalIndex > MAX_MIGRATION_COORDINATE ||
    partitionIndex > MAX_MIGRATION_COORDINATE
  ) {
    // Out-of-range coordinates cannot come from a real migration run —
    // treat the id as an ordinary (non-migrated) stepId so the key-chain
    // iteration stays bounded.
    return null;
  }
  return { pageId, globalIndex, partitionIndex };
}
