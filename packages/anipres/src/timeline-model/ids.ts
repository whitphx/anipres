// Identity helpers for the v2 timeline model.
// Spec: docs/design-animation-data-model.md — "Derived TimelineDoc".

/**
 * Reserved prefix for derived (rule-2 synthetic) step ids. Persisted
 * `stepId`s must never use it — the frame parser diagnoses those as
 * invalid input, and duplication preprocessing freshens them.
 */
export const SYNTHETIC_STEP_PREFIX = "synthstep:";

/**
 * Derived id for a rule-2 recovery step. JSON tuple encoding is required
 * for injectivity: naive ":"-joining is not collision-free because the
 * components may themselves contain ":" (e.g. the `v1step:`-prefixed step
 * ids the one-time v1 migration persisted), so ("a:b", "c") and
 * ("a", "b:c") would concatenate identically.
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
