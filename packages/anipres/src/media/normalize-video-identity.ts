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
  type YouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import { getMediaControlBindingTargetId } from "../shapes/media-control/MediaControlBinding";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";

/**
 * Materializes `videoKey` on every legacy video and fills in the target
 * key of every legacy `mediaControl` frame, deleting markers whose
 * target cannot be resolved at all — the same recovery the mount path
 * used to perform for unbound markers.
 *
 * Reads only what is in the store, so it is deterministic and
 * idempotent: running it again changes nothing.
 */
export function normalizeVideoIdentity(editor: Editor): void {
  const shapes = editor.getCurrentPageShapes();

  const videosNeedingKey: YouTubeEmbedShape[] = [];
  for (const shape of shapes) {
    if (
      isYouTubeEmbedShape(shape) &&
      (shape.props.videoKey == null || shape.props.videoKey === "")
    ) {
      videosNeedingKey.push(shape);
    }
  }

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
      orphanedMarkerIds.push(shape.id);
      continue;
    }
    markerUpdates.push({ shape, videoKey: getVideoKey(target) });
  }

  if (
    videosNeedingKey.length === 0 &&
    markerUpdates.length === 0 &&
    orphanedMarkerIds.length === 0
  ) {
    return;
  }

  editor.run(
    () => {
      if (videosNeedingKey.length > 0) {
        editor.updateShapes(
          videosNeedingKey.map((video) => ({
            id: video.id,
            type: YouTubeEmbedShapeType,
            props: { videoKey: getVideoKey(video) },
          })),
        );
      }
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
