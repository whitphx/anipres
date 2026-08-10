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

/**
 * Fresh identities for the videos in a pasted `TLContent` payload.
 *
 * Runs before the content reaches the store, where the copies do not
 * have their new shape ids yet — so the key is a minted id rather than
 * a carrier's, which the owner rule already allows for (it falls back to
 * the smallest carrier id when no carrier is key-named).
 *
 * A `move` is the same video changing place, not a new one, so it keeps
 * its key; every other operation yields an INDEPENDENT video, which is
 * what makes a copy get its own player rather than joining the source's.
 */
export function remapContentVideoKeys<
  T extends {
    shapes: { id: string; type: string; props?: unknown; meta?: unknown }[];
  },
>(content: T, operation: string, mintKey: () => string): T {
  if (operation === "move") {
    return content;
  }
  const newKeyByOldKey = new Map<string, string>();
  for (const shape of content.shapes) {
    if (shape.type !== YouTubeEmbedShapeType) {
      continue;
    }
    const props = shape.props as { videoKey?: string } | undefined;
    // A payload written before the prop existed falls back to the
    // source shape's id, exactly as a stored record does.
    const oldKey =
      props?.videoKey != null && props.videoKey !== ""
        ? props.videoKey
        : shape.id;
    if (!newKeyByOldKey.has(oldKey)) {
      newKeyByOldKey.set(oldKey, mintKey());
    }
  }
  if (newKeyByOldKey.size === 0) {
    return content;
  }
  return {
    ...content,
    shapes: content.shapes.map((shape) => {
      if (shape.type === YouTubeEmbedShapeType) {
        const props = shape.props as { videoKey?: string } | undefined;
        const oldKey =
          props?.videoKey != null && props.videoKey !== ""
            ? props.videoKey
            : shape.id;
        const newKey = newKeyByOldKey.get(oldKey);
        return newKey == null
          ? shape
          : { ...shape, props: { ...(props ?? {}), videoKey: newKey } };
      }
      if (shape.type !== MediaControlShapeType) {
        return shape;
      }
      const meta = shape.meta as { frame?: unknown } | undefined;
      const parsed = parseFrameMeta(meta?.frame);
      if (parsed.kind !== "v2" || parsed.frame.action.type !== "mediaControl") {
        return shape;
      }
      const oldKey = parsed.frame.action.videoKey;
      const newKey = oldKey != null ? newKeyByOldKey.get(oldKey) : undefined;
      if (newKey == null) {
        return shape;
      }
      return {
        ...shape,
        meta: {
          ...(meta ?? {}),
          frame: frameToMetaJson({
            ...parsed.frame,
            action: { ...parsed.frame.action, videoKey: newKey },
          }),
        },
      };
    }),
  };
}
