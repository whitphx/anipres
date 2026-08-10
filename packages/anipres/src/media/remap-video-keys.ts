// Fresh identities for copied videos.
//
// The follow-up-keyframe path preserves `videoKey` — that is what makes
// a keyframe another carrier of the same video. Copy gestures must do
// the opposite: Cmd+D and paste yield an INDEPENDENT video with its own
// player, which is what the gesture implies. Both run through this.

import { type Editor, type TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";

/**
 * Rewrites the `videoKey` of every video among `createdShapeIds`, and
 * retargets the media events copied alongside them.
 *
 * The new key is the new id of the copied key-named carrier when that
 * carrier is among the copies, and the smallest new id otherwise — so
 * one copied video yields one key however many of its keyframes came
 * along, and the choice does not depend on iteration order.
 */
export function remapDuplicatedVideoKeys(
  editor: Editor,
  createdShapeIds: readonly TLShapeId[],
): void {
  const carriersByOldKey = new Map<string, TLShapeId[]>();
  for (const shapeId of createdShapeIds) {
    const shape = editor.getShape(shapeId);
    if (!isYouTubeEmbedShape(shape)) {
      continue;
    }
    const oldKey = getVideoKey(shape);
    const group = carriersByOldKey.get(oldKey);
    if (group == null) {
      carriersByOldKey.set(oldKey, [shape.id]);
    } else {
      group.push(shape.id);
    }
  }
  if (carriersByOldKey.size === 0) {
    return;
  }

  const newKeyByOldKey = new Map<string, string>();
  for (const [oldKey, carrierIds] of carriersByOldKey) {
    const keyNamed = carrierIds.find((id) => id === oldKey);
    const newKey =
      keyNamed ?? [...carrierIds].sort((a, b) => (a < b ? -1 : 1))[0];
    if (newKey != null) {
      newKeyByOldKey.set(oldKey, newKey);
    }
  }

  for (const [oldKey, carrierIds] of carriersByOldKey) {
    const newKey = newKeyByOldKey.get(oldKey);
    if (newKey == null || newKey === oldKey) {
      continue;
    }
    editor.updateShapes(
      carrierIds.map((id) => ({
        id,
        type: YouTubeEmbedShapeType,
        props: { videoKey: newKey },
      })),
    );
  }

  for (const shapeId of createdShapeIds) {
    const shape = editor.getShape(shapeId);
    if (shape?.type !== MediaControlShapeType) {
      continue;
    }
    const parsed = parseFrameMeta(shape.meta?.frame);
    if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
      continue;
    }
    const oldKey = parsed.frame.action.videoKey;
    const newKey = oldKey != null ? newKeyByOldKey.get(oldKey) : undefined;
    if (newKey == null || newKey === oldKey) {
      continue;
    }
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        ...shape.meta,
        frame: frameToMetaJson({
          ...parsed.frame,
          action: { ...parsed.frame.action, videoKey: newKey },
        }),
      },
    });
  }
}
