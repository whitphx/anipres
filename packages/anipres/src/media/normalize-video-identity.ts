// Brings a document up to the videoKey vocabulary: videos carry their
// own identity, and media events name that identity instead of relying
// on a `media-control` binding to say what they control.
//
// This is normalization, not a schema migration. A tldraw migration
// would stamp new sequence versions into persisted snapshots, and every
// release that might reopen such a snapshot would then have to know
// those versions or refuse the document. Running it as an idempotent
// pass over the store instead keeps the persisted schema additive —
// only optional props — so no snapshot is ever stranded.

import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import { getMediaControlBindingTargetId } from "../shapes/media-control/MediaControlBinding";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";

/**
 * Fills in the target key of every legacy `mediaControl` frame, and
 * deletes markers whose target cannot be resolved at all — the same
 * recovery the mount path used to perform for unbound markers.
 *
 * Deliberately does NOT write the `videoKey` prop. Frames live in
 * `shape.meta`, which tldraw does not validate, so an older build
 * ignores the extra key and the document still loads; the prop is a
 * different matter — an older validator rejects it outright. Writing it
 * merely because a document was opened would make every opened document
 * unloadable after a rollback, so it is materialized lazily instead,
 * when a video is first copied (see `ensureVideoKeyMaterialized`).
 *
 * Reads only what is in the store, so it is deterministic and
 * idempotent: running it again changes nothing.
 */
export function normalizeVideoIdentity(
  editor: Editor,
  options: { soleWriter: boolean },
): void {
  // Every page, not just the open one: a legacy video left unnormalized
  // on another page would have a follow-up keyframe copied from it mint
  // a NEW key — splitting one video in two the first time it is
  // animated — and its events would stay tied to the old binding.
  const shapes = editor.store
    .allRecords()
    .filter((record): record is TLShape => record.typeName === "shape");

  const markerUpdates: { shape: TLShape; videoKey: string }[] = [];
  const orphanedMarkerIds: TLShapeId[] = [];
  for (const shape of shapes) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    const parsed = parseFrameMeta(shape.meta?.frame);
    if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
      continue;
    }
    if (parsed.frame.action.videoKey != null) {
      continue;
    }
    // Pre-videoKey vocabulary: the binding is the only record of what
    // this event controls.
    const targetId = getMediaControlBindingTargetId(editor, shape.id);
    const target = targetId != null ? editor.getShape(targetId) : null;
    if (!isYouTubeEmbedShape(target)) {
      // Unresolvable now is not unresolvable for good: in a shared
      // document the target, or the binding, may simply not have
      // arrived, and a peer's undo can bring either back. Deleting on
      // that evidence destroys an event that cannot be reconstructed,
      // which is the same claim the last-carrier cascade declines to
      // make. The record stays instead, and stays inert — the timeline
      // derivation drops an event naming no live video — until it
      // resolves or an authoritative cleanup settles it.
      if (options.soleWriter) {
        orphanedMarkerIds.push(shape.id);
      }
      continue;
    }
    markerUpdates.push({ shape, videoKey: getVideoKey(target) });
  }

  if (markerUpdates.length === 0 && orphanedMarkerIds.length === 0) {
    return;
  }

  editor.run(
    () => {
      for (const { shape, videoKey } of markerUpdates) {
        const parsed = parseFrameMeta(shape.meta?.frame);
        if (
          parsed.kind !== "v2" ||
          parsed.frame.action.type !== "mediaControl"
        ) {
          continue;
        }
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          meta: {
            ...shape.meta,
            frame: frameToMetaJson({
              ...parsed.frame,
              action: { ...parsed.frame.action, videoKey },
            }),
          },
        });
      }
      if (orphanedMarkerIds.length > 0) {
        editor.deleteShapes(orphanedMarkerIds);
      }
    },
    // Normalization is not a user edit: it must not land on the undo
    // stack, where an undo would re-strand the document it just fixed.
    { history: "ignore" },
  );
}

/**
 * Writes a video's `videoKey` into the record, if it is not there yet.
 *
 * Called at the moment a video is about to be copied — a movement
 * keyframe, a duplicate, a clipboard read — which is the first moment
 * the key has to be stored: a copy made from a video whose key was
 * never written would fall back to its OWN new shape id, splitting one
 * video into two identities. Deferring to here rather than doing it on
 * load is what keeps merely opening a document from writing a property
 * an older build would refuse.
 */
export function ensureVideoKeyMaterialized(
  editor: Editor,
  shapeIds: readonly TLShapeId[],
): void {
  const pending = shapeIds
    .map((shapeId) => editor.getShape(shapeId))
    .filter(isYouTubeEmbedShape)
    .filter((video) => {
      const key = video.meta?.videoKey;
      return typeof key !== "string" || key === "";
    });
  if (pending.length === 0) {
    return;
  }
  editor.updateShapes(
    pending.map((video) => ({
      id: video.id,
      type: YouTubeEmbedShapeType,
      meta: { ...video.meta, videoKey: getVideoKey(video) },
    })),
  );
}
