// What the `media-control` binding used to do, re-expressed on
// `videoKey`: keeping event markers parked at their video, and removing
// them when the video itself is gone.
//
// Both moved off the binding because binding to a shape stopped being
// correct once a video is several carriers — a binding to keyframe #1
// would cascade-delete a video's events when that one keyframe is
// deleted.

import { react, type Editor, type TLShapeId } from "tldraw";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../shapes/media-control/MediaControlShape";
import {
  getDefaultAnchorCarrier,
  groupCarriersByVideoKey,
} from "./video-anchor";
import { isYouTubeEmbedShape } from "../shapes/youtube-embed/YouTubeEmbedShape";
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
export function installVideoLifecycle(editor: Editor): () => void {
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
    (shape) =>
      isYouTubeEmbedShape(shape) && shape.props.videoKey === ""
        ? { ...shape, props: { ...shape.props, videoKey: shape.id } }
        : shape,
  );
  const stopParking = startMarkerParking(editor);
  const stopCleanup = editor.sideEffects.registerOperationCompleteHandler(
    () => {
      deleteOrphanedMediaMarkers(editor);
    },
  );
  return () => {
    stopMinting();
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
export function deleteOrphanedMediaMarkers(editor: Editor): void {
  const shapes = editor.getCurrentPageShapes();
  const liveKeys = new Set(groupCarriersByVideoKey(shapes).keys());
  const orphaned: TLShapeId[] = [];
  for (const shape of shapes) {
    if (shape.type !== MediaControlShapeType) {
      continue;
    }
    const videoKey = resolveMediaControlVideoKey(editor, shape.id);
    // A marker naming no video at all is a degraded record, not an
    // orphan of this operation: normalization owns those at load. This
    // sweep implements one explicit semantic — the video's last carrier
    // went away — and must not become garbage collection, or a marker
    // would vanish in the window between being created and being given
    // its frame.
    if (videoKey != null && !liveKeys.has(videoKey)) {
      orphaned.push(shape.id);
    }
  }
  if (orphaned.length > 0) {
    editor.deleteShapes(orphaned);
  }
}
