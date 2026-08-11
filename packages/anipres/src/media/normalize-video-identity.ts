// Converting a document written before videos carried their own
// identity, when a `media-control` binding was what said which video an
// event controlled.
//
// Run once, off-line, over a document that is all there — not on mount.
// A room populates its store after the editor exists, so a pass at
// mount would look at an empty document and find nothing to convert,
// and a document half-converted is worse than one not converted at all.
//
// Works on the stored records, never through a live store. Loading a
// document into one migrates every record it holds to the running
// tldraw's schema — text shapes gain `richText`, arrows gain props they
// were saved without — and writing that back would turn a media-only
// conversion into a rewrite of the whole deck. A document with no
// legacy media events comes out of this the same object it went in as.

import type {
  Editor,
  TLEditorSnapshot,
  TLShapeId,
  TLStoreSnapshot,
} from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  YouTubeEmbedShapeType,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { MediaControlShapeType } from "../shapes/media-control/MediaControlShape";
import { MediaControlBindingType } from "../shapes/media-control/MediaControlBinding";
import { frameToMetaJson, parseFrameMeta } from "../timeline-model/parse";

/** The record fields this reads; everything else travels untouched. */
interface StoredRecord {
  id: string;
  typeName: string;
  type?: string;
  meta?: Record<string, unknown>;
  fromId?: string;
  toId?: string;
}

type SnapshotLike = TLEditorSnapshot | TLStoreSnapshot;

/**
 * Rewrites every legacy `mediaControl` frame to name its video by key,
 * drops the `media-control` bindings once the keys are written, and
 * removes the events whose target cannot be resolved at all.
 *
 * Deterministic and idempotent: a document already in the current
 * vocabulary comes back unchanged, and so does every record the
 * conversion has no business with.
 */
export function convertLegacyVideoIdentityInSnapshot<T extends SnapshotLike>(
  snapshot: T,
): T {
  const store = storeOf(snapshot);
  if (store == null) {
    return snapshot;
  }
  const records = Object.values(store);

  // Every page, not just one: a legacy video left unconverted elsewhere
  // would have a follow-up keyframe mint a new key the first time it is
  // animated, splitting one video in two.
  const videoKeyById = new Map(
    records
      .filter(
        (record) =>
          record.typeName === "shape" && record.type === YouTubeEmbedShapeType,
      )
      .map((record) => [record.id, getVideoKey(record)] as const),
  );
  const targetByMarkerId = new Map(
    records
      .filter(
        (record) =>
          record.typeName === "binding" &&
          record.type === MediaControlBindingType,
      )
      .map((record) => [record.fromId ?? "", record.toId ?? ""] as const),
  );

  const converted: Record<string, StoredRecord> = {};
  let changed = false;
  for (const [id, record] of Object.entries(store)) {
    const isLegacyBinding =
      record.typeName === "binding" && record.type === MediaControlBindingType;
    if (isLegacyBinding) {
      changed = true;
      continue;
    }
    const parsed =
      record.typeName === "shape" && record.type === MediaControlShapeType
        ? parseFrameMeta(record.meta?.frame)
        : null;
    if (
      parsed == null ||
      parsed.kind !== "v2" ||
      parsed.frame.action.type !== "mediaControl" ||
      parsed.frame.action.videoKey != null
    ) {
      converted[id] = record;
      continue;
    }
    const videoKey = videoKeyById.get(targetByMarkerId.get(id) ?? "");
    if (videoKey == null) {
      // An event with no binding and no resolvable target names nothing
      // and never will: no later record can supply what was already
      // missing when the document was handed over. Conversion owns the
      // document, so it takes those out rather than leaving records
      // nothing can interpret.
      changed = true;
      continue;
    }
    changed = true;
    converted[id] = {
      ...record,
      meta: {
        ...record.meta,
        frame: frameToMetaJson({
          ...parsed.frame,
          action: { ...parsed.frame.action, videoKey },
        }),
      },
    };
  }

  if (!changed) {
    return snapshot;
  }
  // Anything pointing at a record the conversion removed goes with it.
  const survivors = new Set(Object.keys(converted));
  for (const [id, record] of Object.entries(converted)) {
    if (
      record.typeName === "binding" &&
      ((record.fromId != null && !survivors.has(record.fromId)) ||
        (record.toId != null && !survivors.has(record.toId)))
    ) {
      delete converted[id];
    }
  }
  return withStore(snapshot, converted);
}

function storeOf(snapshot: SnapshotLike): Record<string, StoredRecord> | null {
  const store =
    "store" in snapshot && snapshot.store != null
      ? snapshot.store
      : (snapshot as Partial<TLEditorSnapshot>).document?.store;
  return (store as Record<string, StoredRecord> | undefined) ?? null;
}

function withStore<T extends SnapshotLike>(
  snapshot: T,
  store: Record<string, StoredRecord>,
): T {
  return "store" in snapshot && snapshot.store != null
    ? ({ ...snapshot, store } as T)
    : ({
        ...snapshot,
        document: { ...(snapshot as TLEditorSnapshot).document, store },
      } as T);
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
