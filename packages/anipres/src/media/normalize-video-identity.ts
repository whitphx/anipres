// Converting a document written before videos carried their own
// identity, when a `media-control` binding was what said which video an
// event controlled.
//
// Run once, off-line, over a document that is all there — not on mount.
// A room populates its store after the editor exists, so a pass at
// mount would look at an empty document and find nothing to convert,
// and a document half-converted is worse than one not converted at all.
//
// Not a tldraw migration either: a migration stamps new sequence
// versions into persisted snapshots, and every release that might
// reopen such a snapshot would then have to know those versions or
// refuse the document. A pass over the records keeps the persisted
// schema additive, so no snapshot is stranded.

import type {
  Editor,
  TLBinding,
  TLEditorSnapshot,
  TLShape,
  TLShapeId,
  TLStoreSnapshot,
} from "tldraw";
import { loadHeadlessEditor } from "../headless-editor-utils";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import {
  getMediaControlBindingTargetId,
  MediaControlBindingType,
} from "../shapes/media-control/MediaControlBinding";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";

/**
 * Fills in the target key of every legacy `mediaControl` frame, drops
 * the bindings once the keys are written, and removes the markers whose
 * target cannot be resolved at all.
 *
 * Reads only what is in the store, so it is deterministic and
 * idempotent: running it again changes nothing. A document already in
 * the current vocabulary comes out byte-identical.
 */
export function convertLegacyVideoIdentity(editor: Editor): void {
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
      // An event with no binding and no resolvable target names
      // nothing and never will: no later record can supply what was
      // already missing when the document was handed over. Conversion
      // owns the document, so it takes them out rather than leaving
      // records nothing can interpret.
      orphanedMarkerIds.push(shape.id);
      continue;
    }
    markerUpdates.push({ shape, videoKey: getVideoKey(target) });
  }

  // The bindings go once the keys are written. Nothing resolves an
  // event through one any more, so leaving them would leave a second,
  // silent answer to what an event controls — the one every path that
  // creates, copies, moves or deletes a carrier then had to keep in
  // step with the first.
  const staleBindings = editor.store
    .allRecords()
    .filter(
      (record): record is TLBinding =>
        record.typeName === "binding" &&
        (record as TLBinding).type === MediaControlBindingType,
    );

  if (
    markerUpdates.length === 0 &&
    orphanedMarkerIds.length === 0 &&
    staleBindings.length === 0
  ) {
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
      if (staleBindings.length > 0) {
        editor.deleteBindings(staleBindings);
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
  // Normalization, not a user edit, so it is scoped the way the load
  // pass is: an undo that stripped the key would leave the next copy
  // minting a different one for the same video, and a locked carrier
  // must still get it — a lock says the shape may not be moved, not
  // that it has stopped being the video a copy is about to inherit.
  editor.run(
    () => {
      editor.updateShapes(
        pending.map((video) => ({
          id: video.id,
          type: YouTubeEmbedShapeType,
          meta: { ...video.meta, videoKey: getVideoKey(video) },
        })),
      );
    },
    { history: "ignore", ignoreShapeLock: true },
  );
}

/**
 * The same conversion over a stored snapshot, which is how a deck's
 * saved documents are converted: read the JSON, pass it through, write
 * it back.
 */
export function convertLegacyVideoIdentityInSnapshot(
  snapshot: TLEditorSnapshot | TLStoreSnapshot,
): TLEditorSnapshot {
  const [editor, dispose] = loadHeadlessEditor({ snapshot });
  try {
    convertLegacyVideoIdentity(editor);
    return editor.getSnapshot();
  } finally {
    dispose();
  }
}
