// What the `media-control` binding used to do, re-expressed on
// `videoKey`: keeping event markers parked at their video, and removing
// them when the video itself is gone.
//
// Both moved off the binding because binding to a shape stopped being
// correct once a video is several carriers — a binding to keyframe #1
// would cascade-delete a video's events when that one keyframe is
// deleted.

import {
  react,
  type Editor,
  type TLPageId,
  type TLShape,
  type TLShapeId,
} from "tldraw";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import {
  getConfigOwnerCarrier,
  getDefaultAnchorCarrier,
  groupCarriersByVideoKey,
  readStampedVideoConfig,
  resolveVideoConfig,
  restoreStampedVideoConfig,
  type StampedVideoConfig,
} from "./video-anchor";
import {
  getMediaControlBindingTargetId,
  writeLegacyMediaControlBinding,
} from "../shapes/media-control/MediaControlBinding";
import {
  getVideoKey,
  isYouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { normalizeVideoIdentity } from "./normalize-video-identity";

interface MarkerPlacement {
  markerId: TLShapeId;
  x: number;
  y: number;
}

/**
 * Where each marker should sit: at its video's earliest-keyframe
 * carrier, in the marker's own parent space.
 *
 * Deliberately the *default* anchor rule — the one the player uses
 * before any per-client editing override — because parking writes to
 * the document and must be a pure function of it, while which carrier a
 * given user is interacting with is not.
 */
function computeMarkerPlacements(editor: Editor): MarkerPlacement[] {
  const shapes = editor.getCurrentPageShapes();
  const carriersByKey = groupCarriersByVideoKey(shapes);
  if (carriersByKey.size === 0) {
    return [];
  }
  const placements: MarkerPlacement[] = [];
  for (const shape of shapes) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    if (videoKey == null) {
      continue;
    }
    const carriers = carriersByKey.get(videoKey);
    const anchor = carriers != null ? getDefaultAnchorCarrier(carriers) : null;
    if (anchor == null) {
      continue;
    }
    // Page bounds, not the record's own x/y: a carrier nested in a group
    // or a tldraw frame moves without its own record changing, and the
    // marker has to follow that too.
    const bounds = editor.getShapePageBounds(anchor.id);
    if (bounds == null) {
      continue;
    }
    const point = editor.getPointInParentSpace(shape, {
      x: bounds.x,
      y: bounds.y,
    });
    if (shape.x !== point.x || shape.y !== point.y) {
      placements.push({ markerId: shape.id, x: point.x, y: point.y });
    }
  }
  return placements;
}

/**
 * Keeps every media event's marker parked at its video's position.
 *
 * Markers are never rendered, but hidden shapes still count toward
 * `getCurrentPageBounds`, so a marker left behind by a moved video
 * would skew `zoomToFit`. A reaction on the computed page position —
 * rather than a store side effect on the carrier record — is what makes
 * movement that never touches the carrier itself (dragging a parent
 * group, resizing an enclosing frame, reparenting) park just as well as
 * dragging the video does.
 */
export function startMarkerParking(editor: Editor): () => void {
  return react("park media-control markers", () => {
    const placements = computeMarkerPlacements(editor);
    if (placements.length === 0) {
      return;
    }
    editor.run(
      () => {
        editor.updateShapes(
          placements.map((placement) => ({
            id: placement.markerId,
            type: MediaControlShapeType,
            x: placement.x,
            y: placement.y,
          })),
        );
      },
      // Parking is bookkeeping, not an edit the user made: it must not
      // occupy its own undo entry between their real ones.
      { history: "ignore" },
    );
  });
}

/**
 * Everything a document needs for videos to behave, installed in one
 * place so the headless editor (the agent's path) gets it as well as
 * the React one — the binding util used to carry this, and a schema
 * registration reached both.
 */

/**
 * The shapes sharing a page with this one.
 *
 * A video's carriers, and the markers of its events, are page-scoped:
 * everything that resolves one video reads a page's shapes. Deleting a
 * carrier on a page the user is not looking at has to repair that
 * page, not whichever one happens to be open — an off-page deletion
 * repaired against the current page repairs nothing and reads a video
 * that is not there.
 */
function shapesOnSamePage(editor: Editor, shape: TLShape): TLShape[] {
  const pageId = editor.getAncestorPageId(shape);
  if (pageId == null) {
    return [];
  }
  return [...editor.getPageShapeIds(pageId)]
    .map((shapeId) => editor.getShape(shapeId))
    .filter((pageShape) => pageShape != null);
}

export interface VideoLifecycleOptions {
  /**
   * Whether this client is the only writer of the document.
   *
   * The last-carrier cascade is a claim a client cannot settle when it
   * is not: another client may be adding a carrier for the same video at
   * that moment, and the merge would keep that carrier while keeping
   * these deletions — a video surviving without its events, which no
   * later pass can reconstruct. Arbitrating it needs the room server
   * (see the design's Rollout), which is not built, so a shared document
   * takes the recoverable failure instead: the markers are left in
   * place, invisible and inert, rather than destroyed.
   */
  soleWriter?: boolean;
}

export function installVideoLifecycle(
  editor: Editor,
  options: VideoLifecycleOptions = {},
): () => void {
  const soleWriter = options.soleWriter ?? true;
  // The load-side normalization authority for an unsynced document:
  // legacy videos get their `videoKey`, legacy events get the target key
  // that used to live in a binding.
  normalizeVideoIdentity(editor);
  // A placed video mints its identity as its own id. Written at
  // creation rather than left to the read-time fallback: a follow-up
  // keyframe copied from a video whose key was never stored would fall
  // back to its OWN new id, splitting one video into two identities the
  // first time it is animated. Copies arrive carrying a key already and
  // keep it here — the duplicate path mints them a fresh one.
  const stopMinting = editor.sideEffects.registerBeforeCreateHandler(
    "shape",
    (shape, source) => {
      // A record arriving from a peer is stored as sent. Correcting it
      // towards this client's view of the video would leave two
      // clients holding different props under one record id, each
      // correcting the other — the outcome the revision stamps exist
      // to prevent — and the peer has already run this on its side.
      if (source === "remote" || !isYouTubeEmbedShape(shape)) {
        return shape;
      }
      const carrierKey = shape.meta?.videoKey;
      if (typeof carrierKey !== "string" || carrierKey === "") {
        return { ...shape, meta: { ...shape.meta, videoKey: shape.id } };
      }
      // A new carrier of an existing video is born holding that video's
      // configuration. Read-time resolution does not depend on it — the
      // owner answers — but it means every carrier knows the video, so
      // losing the owner cannot leave the survivors unable to say what
      // the video is. Nothing else can repair that in a shared document,
      // where no client may write on another's behalf.
      const carriers = groupCarriersByVideoKey(
        shapesOnSamePage(editor, shape),
      ).get(carrierKey);
      const config =
        carriers != null && carriers.length > 0
          ? resolveVideoConfig(carriers)
          : null;
      return config == null || config.videoId === ""
        ? shape
        : { ...shape, props: { ...shape.props, ...config } };
    },
  );
  const stopParking = startMarkerParking(editor);
  // The cascade is an explicit deletion semantic, not garbage
  // collection: it runs only for an operation that actually removed a
  // carrier, and asks the store once afterwards. Sweeping on every
  // completed operation would make an unrelated edit able to remove
  // markers, which is a wider claim than "this operation deleted the
  // video".
  let deletedCarrierKeys: Set<string> | null = null;
  // The pages the deletions touched, read while the records are still
  // resolvable: by the time the operation completes they are gone, and
  // with them any way to ask which page they were on.
  let deletedPageIds: Set<TLPageId> | null = null;
  const capturedConfigs = new Map<string, StampedVideoConfig>();
  // Read while every carrier is still present: the stamps that won a
  // property may live only on the record about to go.
  const stopCaptureConfigs = editor.sideEffects.registerBeforeDeleteHandler(
    "shape",
    (shape) => {
      if (!isYouTubeEmbedShape(shape)) {
        return;
      }
      const pageId = editor.getAncestorPageId(shape);
      if (pageId != null) {
        deletedPageIds ??= new Set();
        deletedPageIds.add(pageId);
      }
      const videoKey = getVideoKey(shape);
      if (capturedConfigs.has(videoKey)) {
        return;
      }
      const captured = readStampedVideoConfig(
        groupCarriersByVideoKey(shapesOnSamePage(editor, shape)).get(
          videoKey,
        ) ?? [],
      );
      if (captured != null) {
        capturedConfigs.set(videoKey, captured);
      }
    },
  );
  const stopWatchDeletes = editor.sideEffects.registerAfterDeleteHandler(
    "shape",
    (shape) => {
      if (!isYouTubeEmbedShape(shape)) {
        return;
      }
      deletedCarrierKeys ??= new Set();
      deletedCarrierKeys.add(getVideoKey(shape));
    },
  );
  const stopCleanup = editor.sideEffects.registerOperationCompleteHandler(
    () => {
      const keys = deletedCarrierKeys;
      deletedCarrierKeys = null;
      if (keys == null) {
        return;
      }
      const pageIds = deletedPageIds ?? new Set<TLPageId>();
      deletedPageIds = null;
      for (const pageId of pageIds) {
        const shapes = [...editor.getPageShapeIds(pageId)]
          .map((shapeId) => editor.getShape(shapeId))
          .filter((shape) => shape != null);
        // Safe in any document: the heir is a pure function of the
        // survivors, so concurrent clients repoint identically.
        repointLegacyBindings(editor, keys, shapes);
        // Also safe in any document: it re-imposes values that had
        // already won, carrying the stamps that won them, onto every
        // survivor rather than onto one chosen record a concurrent push
        // could delete out from under it. Two clients performing it
        // write the same pairs, so it converges, and a later edit
        // outranks it. Withholding it is what is unsafe — deleting the
        // carrier whose stamps won a property would drop the video back
        // to whatever a stale carrier happened to be holding, with
        // nothing left to say the configuration had ever been edited.
        for (const [videoKey, captured] of capturedConfigs) {
          restoreStampedVideoConfig(editor, videoKey, captured, shapes);
        }
        if (soleWriter) {
          deleteOrphanedMediaMarkers(editor, keys, shapes);
        }
      }
      capturedConfigs.clear();
    },
  );
  return () => {
    stopMinting();
    stopCaptureConfigs();
    stopWatchDeletes();
    stopParking();
    stopCleanup();
  };
}

/**
 * Deletes the event markers of every video that just lost its last
 * carrier.
 *
 * The check runs once against the store after the whole batch rather
 * than per shape during it: deleting every keyframe of a video in one
 * selection would otherwise let each removal see the others' carriers as
 * still present and conclude nothing was orphaned. Deleting one keyframe
 * of an animated video correspondingly leaves the events alone — which
 * the binding's per-shape cascade got wrong.
 */
/**
 * Repoints the compatibility bindings whose video carrier just went
 * away, for videos that still have one.
 *
 * The binding exists so an older build can still resolve an event —
 * it deletes a marker that has none as an orphan. tldraw removes a
 * binding with its endpoint, so deleting any one carrier would strip
 * that protection from the video's events while the video itself lives
 * on. Repointing is a pure function of the surviving carriers, so every
 * client computes the same answer and repeating it changes nothing.
 */
function repointLegacyBindings(
  editor: Editor,
  videoKeys: ReadonlySet<string>,
  shapes: readonly TLShape[],
): void {
  if (videoKeys.size === 0) {
    return;
  }
  const carriersByKey = groupCarriersByVideoKey(shapes);
  for (const shape of shapes) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    if (videoKey == null || !videoKeys.has(videoKey)) {
      continue;
    }
    const carriers = carriersByKey.get(videoKey);
    const heir = carriers != null ? getConfigOwnerCarrier(carriers) : null;
    if (heir == null) {
      // No carrier left: the marker goes too, bindings with it.
      continue;
    }
    if (getMediaControlBindingTargetId(editor, shape.id) != null) {
      continue;
    }
    writeLegacyMediaControlBinding(editor, shape.id, heir.id);
  }
}

export function deleteOrphanedMediaMarkers(
  editor: Editor,
  /** Only these videos are considered; others are none of this
   * operation's business. */
  videoKeys: ReadonlySet<string>,
  shapes: readonly TLShape[],
): void {
  if (videoKeys.size === 0) {
    return;
  }
  const liveKeys = new Set(groupCarriersByVideoKey(shapes).keys());
  const orphaned: TLShapeId[] = [];
  for (const shape of shapes) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    // A marker naming no video at all is a degraded record, not an
    // orphan of this operation: normalization owns those at load.
    if (
      videoKey != null &&
      videoKeys.has(videoKey) &&
      !liveKeys.has(videoKey)
    ) {
      orphaned.push(shape.id);
    }
  }
  if (orphaned.length > 0) {
    editor.deleteShapes(orphaned);
  }
}
