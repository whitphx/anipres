import type { Editor, RecordProps, TLBaseBinding, TLShapeId } from "tldraw";

export const MediaControlBindingType = "media-control" as const;

export type MediaControlBindingProps = Record<string, never>;

/**
 * How a marker records which video its event controls, `fromId` being
 * the marker and `toId` the video. Nothing in this build resolves an
 * event through it — an event names its video by `videoKey` in its own
 * frame, which a video that is several carriers needs, since a binding
 * to one keyframe would tie the whole video's events to that
 * keyframe's fate.
 *
 * It is still written, and still read in two places, so neither the
 * writer nor the reader is dead code:
 *
 * - `writeLegacyMediaControlBinding` below writes it beside every
 *   event, and the video lifecycle repoints it as carriers come and
 *   go, for an older build that resolves an event only this way.
 * - `getMediaControlBindingTargetId` below reads it as the fallback in
 *   `resolveMediaControlVideoKey`, which is how a document written
 *   before `videoKey` existed still resolves, and how
 *   `normalizeVideoIdentity` recovers the target key on load.
 *
 * See `MediaControlBindingUtil` for why the type stays registered.
 */
export type MediaControlBinding = TLBaseBinding<
  typeof MediaControlBindingType,
  MediaControlBindingProps
>;

export const mediaControlBindingProps: RecordProps<MediaControlBinding> = {};

/** The video a marker is bound to, or null for an orphaned marker. */
export function getMediaControlBindingTargetId(
  editor: Editor,
  markerShapeId: TLShapeId,
): TLShapeId | null {
  const [binding] = editor.getBindingsFromShape<MediaControlBinding>(
    markerShapeId,
    MediaControlBindingType,
  );
  return binding?.toId ?? null;
}

/**
 * Records a marker's video the way releases before `videoKey` did.
 *
 * Nothing here reads it — an event names its video in its own frame —
 * but an older build resolves events only through this binding and
 * deletes a marker without one as an orphan. Writing it anyway is what
 * keeps a document opened by such a build from silently losing every
 * event this one authored.
 */
export function writeLegacyMediaControlBinding(
  editor: Editor,
  markerShapeId: TLShapeId,
  videoShapeId: TLShapeId,
): void {
  editor.createBinding({
    type: MediaControlBindingType,
    fromId: markerShapeId,
    toId: videoShapeId,
    props: {},
  });
}
