// Fresh identities for copied videos.
//
// The follow-up-keyframe path preserves `videoKey` — that is what makes
// a keyframe another carrier of the same video. Copy gestures must do
// the opposite: Cmd+D and paste yield an INDEPENDENT video with its own
// player, which is what the gesture implies. Both run through this.

import { type Editor, type JsonObject, type TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import {
  getConfigOwnerCarrier,
  groupCarriersByVideoKey,
  resolveVideoConfig,
  type VideoConfig,
} from "./video-anchor";
import {
  MediaControlBindingType,
  writeLegacyMediaControlBinding,
} from "../shapes/media-control/MediaControlBinding";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";
import type { Frame } from "../timeline-model/types";

/**
 * A carrier's metadata under a newly minted identity.
 *
 * The revision history goes with the old key: a new video is not heir
 * to the edits of the one it was copied from. Nothing observable turns
 * on it today, since an edit rewrites the stamp on every carrier it
 * can see and so outranks whatever was inherited, but the same rule
 * governs content arriving through the clipboard and one identity
 * rule beats two.
 */
function freshIdentityMeta(
  meta: Partial<JsonObject> | undefined,
  videoKey: string,
): Partial<JsonObject> {
  const next = { ...meta };
  delete next.videoConfigRev;
  return { ...next, videoKey };
}

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

  // The source video's configuration lives on ONE of its carriers, and
  // the copied selection need not include it — duplicating a later
  // keyframe copies a record whose own media props may be blank or
  // superseded. Resolve the source's configuration while the source is
  // still in hand and stamp it onto the copies, or the new independent
  // video would be born wrong.
  const created = new Set<string>(createdShapeIds);
  const sourceConfigByOldKey = new Map<string, VideoConfig>();
  const sourceCarriers = groupCarriersByVideoKey(
    editor.getCurrentPageShapes().filter((shape) => !created.has(shape.id)),
  );
  for (const oldKey of carriersByOldKey.keys()) {
    const config = resolveVideoConfig(sourceCarriers.get(oldKey) ?? []);
    if (config != null) {
      sourceConfigByOldKey.set(oldKey, config);
    }
  }

  for (const [oldKey, carrierIds] of carriersByOldKey) {
    const newKey = newKeyByOldKey.get(oldKey);
    if (newKey == null) {
      continue;
    }
    const config = sourceConfigByOldKey.get(oldKey);
    const ownerId = carrierIds.includes(newKey as TLShapeId)
      ? (newKey as TLShapeId)
      : null;
    if (newKey === oldKey && config == null) {
      continue;
    }
    // Locked too: tldraw copies `isLocked` with the shape, and a copy
    // that kept the source's key would join the source video instead
    // of being the independent one a duplicate is.
    editor.run(
      () => {
        editor.updateShapes(
          carrierIds.map((id) => ({
            id,
            type: YouTubeEmbedShapeType,
            ...(newKey !== oldKey
              ? { meta: freshIdentityMeta(editor.getShape(id)?.meta, newKey) }
              : {}),
            // Only the copy's own owner needs the configuration; the
            // others resolve through it.
            ...(config != null && id === ownerId
              ? { props: { ...config } }
              : {}),
          })),
        );
      },
      { ignoreShapeLock: true },
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
    rebindCopiedMarker(editor, shape.id, newKey);
  }
}

/**
 * Points a copied event's compatibility binding at the video it now
 * names.
 *
 * Duplication creates the shapes first and rewrites their keys here
 * afterwards, so the lifecycle's own repair has already run, against
 * the key the marker arrived with. Whatever binding it has is from the
 * source: pointing at the source's own carrier when that carrier was
 * not part of the copy, or absent when it was a later keyframe that
 * carried no binding. Either way an older build, which resolves an
 * event only through the binding, would read the copy's event as the
 * source video's or as an orphan to delete.
 */
function rebindCopiedMarker(
  editor: Editor,
  markerShapeId: TLShapeId,
  videoKey: string,
): void {
  const carriers = groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
    videoKey,
  );
  const heir = carriers != null ? getConfigOwnerCarrier(carriers) : null;
  if (heir == null) {
    return;
  }
  const existing = editor.getBindingsFromShape(
    markerShapeId,
    MediaControlBindingType,
  );
  if (existing.some((binding) => binding.toId === heir.id)) {
    return;
  }
  if (existing.length > 0) {
    editor.deleteBindings(existing);
  }
  writeLegacyMediaControlBinding(editor, markerShapeId, heir.id);
}

/** The video a clipboard record belongs to; see `getVideoKey`. */
function contentVideoKey(shape: { id: string; meta?: unknown }): string {
  const key = (shape.meta as { videoKey?: unknown } | undefined)?.videoKey;
  return typeof key === "string" && key !== "" ? key : shape.id;
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
>(
  content: T,
  operation: string,
  mintKey: () => string,
  /**
   * The source video's configuration, when the source document is this
   * one — a same-document copy of a later keyframe carries that
   * keyframe's own props, which may be blank or superseded.
   *
   * Consulted for a duplicate only, and ignored otherwise however the
   * caller passes it. An external paste has no source here to ask: a
   * key resolving in THIS document belongs to a different video that
   * happens to share the key, two documents forked from one snapshot
   * being all it takes, and answering from it would overwrite what the
   * payload carries with the wrong video's settings. The payload was
   * canonicalized where it was copied, so its own values stand.
   */
  resolveSourceConfig?: (videoKey: string) => VideoConfig | null,
): T {
  if (operation === "move") {
    return content;
  }
  const sourceConfigOf =
    operation === "duplicate" ? resolveSourceConfig : undefined;
  const newKeyByOldKey = new Map<string, string>();
  for (const shape of content.shapes) {
    if (shape.type !== YouTubeEmbedShapeType) {
      continue;
    }
    // A payload from a video that was never copied carries no key, and
    // falls back to the source shape's id exactly as a stored record
    // does.
    const oldKey = contentVideoKey(shape);
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
        const oldKey = contentVideoKey(shape);
        const newKey = newKeyByOldKey.get(oldKey);
        if (newKey == null) {
          return shape;
        }
        const config = sourceConfigOf?.(oldKey) ?? null;
        // A fresh identity starts with a fresh revision history: the
        // stamps in the payload order the SOURCE video's edits, and
        // carrying them over would let a payload from anywhere pin this
        // new video's configuration where no local edit could outrank
        // it.
        const meta = { ...(shape.meta as Record<string, unknown> | undefined) };
        delete meta.videoConfigRev;
        return {
          ...shape,
          props: {
            ...(shape.props as object | undefined),
            ...(config ?? {}),
          },
          meta: { ...meta, videoKey: newKey },
        };
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

/**
 * Drops from a move's payload the shapes it never actually removed.
 *
 * A copy of a video carries its event markers, which the user never
 * selected. A cut deletes what was selected, and where the marker
 * cleanup is withheld — a shared document, where claiming a video lost
 * its last carrier is not one client's call — the markers outlive the
 * carrier. Pasting the payload whole would then lay a second copy of
 * each marker beside the one that never left, giving the video two
 * records of every event.
 *
 * A move re-creates what it removed and nothing else, so a shape whose
 * record is already where the content is going is dropped, along with
 * any binding that pointed at it. Already *here* rather than anywhere
 * in the document: a video moved to another page leaves its markers
 * behind on the page it left, and those have to be laid down again,
 * a video and its events being page-scoped.
 */
export function dropContentAlreadyInDocument<
  T extends {
    shapes: { id: string }[];
    bindings?: { fromId: string; toId: string }[];
  },
>(content: T, shapeIsAlreadyHere: (shapeId: string) => boolean): T {
  const dropped = new Set(
    content.shapes.map((shape) => shape.id).filter(shapeIsAlreadyHere),
  );
  if (dropped.size === 0) {
    return content;
  }
  return {
    ...content,
    shapes: content.shapes.filter((shape) => !dropped.has(shape.id)),
    ...(content.bindings != null
      ? {
          bindings: content.bindings.filter(
            (binding) =>
              !dropped.has(binding.fromId) && !dropped.has(binding.toId),
          ),
        }
      : {}),
  };
}

/**
 * The complete content transformation the paste path applies: timeline
 * frame identities first, then video identities.
 *
 * The order is load-bearing and easy to get backwards. Frame remapping
 * replaces a marker's whole frame with one derived from the ORIGINAL
 * payload, so rewriting video keys before it would see them restored to
 * the source video's — leaving a pasted copy driving the original, or,
 * for an external paste, holding events for a video that is not there.
 */
export function applyPasteRemapToContent<
  T extends {
    shapes: { id: string; type: string; props?: unknown; meta?: unknown }[];
  },
>(
  content: T,
  updatedFrames: ReadonlyMap<string, Frame>,
  options: {
    operation: string;
    mintKey: () => string;
    resolveSourceConfig?: (videoKey: string) => VideoConfig | null;
  },
): T {
  const withFrames =
    updatedFrames.size === 0
      ? content
      : {
          ...content,
          shapes: content.shapes.map((shape) => {
            const frame = updatedFrames.get(shape.id);
            return frame != null
              ? {
                  ...shape,
                  meta: {
                    ...(shape.meta as object | undefined),
                    frame: frameToMetaJson(frame),
                  },
                }
              : shape;
          }),
        };
  return remapContentVideoKeys(
    withFrames as T,
    options.operation,
    options.mintKey,
    options.resolveSourceConfig,
  );
}

/**
 * Writes each copied video's canonical configuration into clipboard
 * content, on the source side where the source document is still in
 * hand.
 *
 * A video's configuration lives on one owner carrier, and a copy need
 * not include it — copying a later keyframe copies a record whose own
 * media props may be blank or superseded. The destination of an
 * external paste has no source to ask, so if the payload leaves without
 * the real values they are simply gone, and the paste creates a video
 * that names nothing.
 */
export function canonicalizeContentVideoConfig<
  T extends {
    shapes: { id: string; type: string; props?: unknown }[];
  },
>(content: T, resolveConfig: (videoKey: string) => VideoConfig | null): T {
  let changed = false;
  const shapes = content.shapes.map((shape) => {
    if (shape.type !== YouTubeEmbedShapeType) {
      return shape;
    }
    const config = resolveConfig(contentVideoKey(shape));
    if (config == null) {
      return shape;
    }
    changed = true;
    return {
      ...shape,
      props: { ...(shape.props as object | undefined), ...config },
    };
  });
  return changed ? { ...content, shapes } : content;
}
