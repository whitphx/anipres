// @internal — legacy v1 type, kept only because the legacy v1 frame types
// in `models.ts` reference it. Order derivation goes through
// `timeline-model`'s deriveTimeline
// (docs/design-animation-data-model.md).
export interface OrderedTrackItem<T = unknown> {
  id: string;
  globalIndex: number;
  trackId: string;
  data: T;
}
