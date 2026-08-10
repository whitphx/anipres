// Which carrier the live player follows, per video.
//
// This is explicit runtime state, never derived from what happens to be
// rendered: during an animated step there is no visible carrier at all
// (runStep hides the incoming frame's carrier for the length of the
// tween, and the outgoing one has stopped being current), so a rule
// reading rendered visibility would lose the anchor exactly when the
// player must keep moving.

import { uniqueId } from "tldraw";
import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  type YouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { parseFrameMeta } from "../timeline-model/parse";

/** Every carrier on the page, grouped by the video they belong to. */
export function groupCarriersByVideoKey(
  shapes: readonly TLShape[],
): Map<string, YouTubeEmbedShape[]> {
  const groups = new Map<string, YouTubeEmbedShape[]>();
  for (const shape of shapes) {
    if (!isYouTubeEmbedShape(shape)) {
      continue;
    }
    const key = getVideoKey(shape);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [shape]);
    } else {
      group.push(shape);
    }
  }
  return groups;
}

/**
 * The carrier of a video's earliest keyframe — its starting position,
 * and the default anchor while editing.
 *
 * A pure function of the converged document, deliberately without the
 * per-client editing override: marker parking uses this same rule and
 * must agree across clients.
 */
export function getDefaultAnchorCarrier(
  carriers: YouTubeEmbedShape[],
): YouTubeEmbedShape | null {
  if (carriers.length === 0) {
    return null;
  }
  if (carriers.length === 1) {
    return carriers[0] ?? null;
  }
  // Ordering by the frame each carrier holds: a cue frame's step order
  // key places it in the presentation, and a carrier without an
  // interpretable frame sorts last so a framed keyframe always wins.
  let best: YouTubeEmbedShape | null = null;
  let bestKey: string | null = null;
  for (const carrier of carriers) {
    const parsed = parseFrameMeta(carrier.meta?.frame);
    const orderKey =
      parsed.kind === "v2" && parsed.frame.type === "cue"
        ? parsed.frame.stepOrderKey
        : null;
    if (best == null) {
      best = carrier;
      bestKey = orderKey;
      continue;
    }
    if (orderKey == null) {
      continue;
    }
    if (
      bestKey == null ||
      orderKey < bestKey ||
      // Stable tie-break so every client picks the same carrier.
      (orderKey === bestKey && carrier.id < best.id)
    ) {
      best = carrier;
      bestKey = orderKey;
    }
  }
  return best;
}

/** The media properties that describe the video, not a keyframe. */
export interface VideoConfig {
  videoId: string;
  url: string;
  start: number;
  muted: boolean;
  controls: boolean;
  altText: string;
}

/**
 * The carrier that owns a video's configuration: the one whose id is
 * the `videoKey` — the shape that placed the video — while it lives,
 * and the smallest surviving id otherwise.
 *
 * Deliberately independent of the anchor. The anchor moves with the
 * presentation and with which keyframe a user is editing; the
 * configuration must not, or the same video would answer differently
 * about which video it *is* depending on where the presentation stands.
 */
export function getConfigOwnerCarrier(
  carriers: YouTubeEmbedShape[],
): YouTubeEmbedShape | null {
  if (carriers.length === 0) {
    return null;
  }
  const keyNamed = carriers.find(
    (carrier) => carrier.id === getVideoKey(carrier),
  );
  if (keyNamed != null) {
    return keyNamed;
  }
  return carriers.reduce((best, carrier) =>
    carrier.id < best.id ? carrier : best,
  );
}

/**
 * A per-property Lamport stamp: a counter, plus the id of the editing
 * session that wrote it so equal counters still order totally.
 */
export interface ConfigStamp {
  c: number;
  s: string;
  // Meta is JSON, and tldraw's JsonObject requires an index signature.
  [key: string]: number | string;
}

/**
 * Exclusive: a counter at or above this is not ordering evidence.
 *
 * Far above any editing history and far below the safe-integer limit,
 * so `highest + 1` always advances. The ceiling is exclusive on both
 * sides — nothing readable reaches it and nothing written approaches it
 * — because the accepted range has to be closed under the increment
 * `updateVideoConfig` performs. Were the ceiling itself accepted, a
 * carrier holding it would push the next local stamp one past what a
 * read allows, and an edit whose stamp cannot be read carries no
 * ordering evidence at all: the carrier at the ceiling would win again,
 * which is exactly what bounding the counter is meant to prevent.
 */
export const CONFIG_STAMP_CEILING = 1_000_000_000;

const VIDEO_CONFIG_KEYS = [
  "videoId",
  "url",
  "start",
  "muted",
  "controls",
  "altText",
] as const;
type VideoConfigKey = (typeof VIDEO_CONFIG_KEYS)[number];

function readStamps(
  carrier: YouTubeEmbedShape,
): Partial<Record<VideoConfigKey, ConfigStamp>> {
  const raw = carrier.meta?.videoConfigRev;
  if (raw == null || typeof raw !== "object") {
    return {};
  }
  const stamps: Partial<Record<VideoConfigKey, ConfigStamp>> = {};
  for (const key of VIDEO_CONFIG_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    // Bounded, because a stamp can arrive from outside: a pasted
    // payload carrying `Number.MAX_VALUE` and a lexically maximal
    // session id would win forever, and `highest + 1` does not advance
    // at that magnitude — the video's configuration could never be
    // edited again.
    if (
      value != null &&
      typeof value === "object" &&
      Number.isSafeInteger((value as ConfigStamp).c) &&
      (value as ConfigStamp).c >= 0 &&
      (value as ConfigStamp).c < CONFIG_STAMP_CEILING &&
      typeof (value as ConfigStamp).s === "string"
    ) {
      stamps[key] = {
        c: (value as ConfigStamp).c,
        s: (value as ConfigStamp).s,
      };
    }
  }
  return stamps;
}

/** Later wins; equal counters are broken by session id, so the order is total. */
function stampBeats(a: ConfigStamp, b: ConfigStamp | undefined): boolean {
  if (b == null) return true;
  return a.c !== b.c ? a.c > b.c : a.s > b.s;
}

/**
 * One configuration per video, resolved **per property**.
 *
 * Sharing an identity means sharing a configuration: `url`, `videoId`,
 * `start`, `muted`, `controls` and `altText` describe the video, and two
 * carriers of one `videoKey` disagreeing about `videoId` is incoherent.
 *
 * Which carrier answers is decided by the stamp each property carries,
 * not by which record happens to hold it. That is what converges under
 * concurrency: a carrier another client created from an older view of
 * the video arrives with older stamps (or none) and loses, where a rule
 * reading structure — "the owner", "the smallest id" — would promote it
 * the moment the edited carriers went away.
 *
 * Properties nothing has ever stamped fall back to the owner, then to
 * any carrier that knows the video: unstamped values are birth copies,
 * identical wherever they sit, except for a carrier that predates the
 * video being configured at all.
 */
export function resolveVideoConfig(
  carriers: YouTubeEmbedShape[],
): VideoConfig | null {
  const preferred = getConfigOwnerCarrier(carriers);
  if (preferred == null) {
    return null;
  }
  // The unstamped fallback: the owner answers unless it has nothing to
  // say, in which case any carrier that knows the video is better than
  // one that does not.
  const fallback =
    preferred.props.videoId !== ""
      ? preferred
      : ([...carriers]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .find((carrier) => carrier.props.videoId !== "") ?? preferred);

  const winners = new Map<VideoConfigKey, YouTubeEmbedShape>();
  const best = new Map<VideoConfigKey, ConfigStamp>();
  for (const carrier of carriers) {
    const stamps = readStamps(carrier);
    for (const key of VIDEO_CONFIG_KEYS) {
      const stamp = stamps[key];
      if (stamp != null && stampBeats(stamp, best.get(key))) {
        best.set(key, stamp);
        winners.set(key, carrier);
      }
    }
  }

  const pick = <K extends VideoConfigKey>(key: K): VideoConfig[K] =>
    (winners.get(key) ?? fallback).props[key];
  return {
    videoId: pick("videoId"),
    url: pick("url"),
    start: pick("start"),
    muted: pick("muted"),
    controls: pick("controls"),
    altText: pick("altText"),
  };
}

/**
 * Whether a carrier is actually on stage, ancestors included.
 *
 * A shape-owned player used to inherit its parent's hiding through the
 * DOM for free. The runtime player is rendered outside that hierarchy,
 * so a carrier inside a hidden group or frame would otherwise keep a
 * visible, audible player before its container ever appears — the
 * ancestor chain has to be walked explicitly.
 */
function isEffectivelyVisible(
  editor: Editor,
  shapeId: TLShapeId,
  visibilities: Record<string, "visible" | "hidden" | "inherit">,
): boolean {
  let current: TLShapeId | undefined = shapeId;
  while (current != null) {
    if (visibilities[current] === "hidden") {
      return false;
    }
    const parent: TLShape | undefined = editor.getShape(current);
    const parentId: string | undefined = parent?.parentId;
    current =
      parentId != null && parentId.startsWith("shape:")
        ? (parentId as TLShapeId)
        : undefined;
  }
  return true;
}

/**
 * The carrier the player should follow right now.
 *
 * While presenting, the visibility rule already answers it — the anchor
 * is the carrier that rule shows. While editing every carrier is
 * visible, so the default rule applies, overridden for the duration by
 * a carrier the user has entered the editing state on, so that every
 * visible keyframe is a place the video can be driven from.
 */
export function resolveAnchorCarrier(
  editor: Editor,
  carriers: YouTubeEmbedShape[],
  options: {
    presentationMode: boolean;
    visibilities?: Record<string, "visible" | "hidden" | "inherit">;
  },
): YouTubeEmbedShape | null {
  if (carriers.length === 0) {
    return null;
  }
  if (options.presentationMode) {
    const visibilities = options.visibilities;
    if (visibilities == null) {
      return getDefaultAnchorCarrier(carriers);
    }
    const shown = carriers.filter((carrier) =>
      isEffectivelyVisible(editor, carrier.id, visibilities),
    );
    // No shown carrier means the video is not on stage yet (before its
    // cue step, or rewound past it): Absent, and the caller unmounts.
    if (shown.length === 0) {
      return null;
    }
    return getDefaultAnchorCarrier(shown);
  }
  // Entering a carrier's editing state brings the player to it, before
  // any pointer input can reach the player.
  const editingShapeId = editor.getEditingShapeId();
  if (editingShapeId != null) {
    const editing = carriers.find((carrier) => carrier.id === editingShapeId);
    if (editing != null) {
      return editing;
    }
  }
  return getDefaultAnchorCarrier(carriers);
}

/**
 * Writes a configuration change to every carrier of a video, stamping
 * each changed property.
 *
 * Mirroring alone does not converge — the design says so — because two
 * clients writing the same property to different records leaves nothing
 * to order them. The stamp is what orders them, so mirroring becomes
 * safe: every carrier ends up holding the value *and* the stamp that
 * says how recent it is, and a carrier created concurrently from an
 * older view loses on read no matter which records survive.
 */
export function updateVideoConfig(
  editor: Editor,
  videoKey: string,
  patch: Partial<VideoConfig>,
): void {
  const carriers =
    groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(videoKey) ?? [];
  if (carriers.length === 0) {
    return;
  }
  const changed = VIDEO_CONFIG_KEYS.filter((key) => patch[key] !== undefined);
  if (changed.length === 0) {
    return;
  }
  const session = getEditSessionId(editor);
  const stamps: Partial<Record<VideoConfigKey, ConfigStamp>> = {};
  for (const key of changed) {
    // One past the highest this video has seen, so the edit wins every
    // value it is replacing.
    let highest = 0;
    for (const carrier of carriers) {
      const stamp = readStamps(carrier)[key];
      if (stamp != null && stamp.c > highest) {
        highest = stamp.c;
      }
    }
    // Held inside the range a read accepts, so an edit always carries
    // ordering evidence. At the very top it can only tie the counter
    // it found, leaving the session id to decide — the one case a
    // client cannot settle on its own, and the reason the room server
    // is the design's authority for stamps. Starting the counter over
    // instead would be worse than the tie: a carrier this client has
    // never seen can still merge holding the high counter, and would
    // then outrank the restart and revert the property. No honest
    // history reaches here; the ceiling sits far above any of them.
    stamps[key] = {
      c: Math.min(highest, CONFIG_STAMP_CEILING - 2) + 1,
      s: session,
    };
  }
  // Locked too. A lock says a shape must not be moved or reshaped on
  // the canvas; it says nothing about which records make up one video,
  // and skipping a locked carrier would leave it holding a stale
  // configuration to seat later, when the carrier that was edited is
  // deleted.
  editor.run(
    () => {
      editor.updateShapes(
        carriers.map((carrier) => ({
          id: carrier.id,
          type: carrier.type,
          props: { ...patch },
          meta: {
            ...carrier.meta,
            videoConfigRev: {
              ...(typeof carrier.meta?.videoConfigRev === "object" &&
              carrier.meta.videoConfigRev != null
                ? carrier.meta.videoConfigRev
                : {}),
              ...stamps,
            },
          },
        })),
      );
    },
    { ignoreShapeLock: true },
  );
}

// One id per editor instance, so two clients editing the same property
// from the same counter still order deterministically everywhere.
const editSessionIds = new WeakMap<Editor, string>();
function getEditSessionId(editor: Editor): string {
  let id = editSessionIds.get(editor);
  if (id == null) {
    id = uniqueId();
    editSessionIds.set(editor, id);
  }
  return id;
}

export interface StampedVideoConfig {
  config: VideoConfig;
  stamps: Record<string, ConfigStamp>;
}

/**
 * A video's resolved configuration together with the stamps that won
 * it, read while every carrier is still present.
 *
 * A stamp only orders the records that hold it, so deleting the
 * carriers an edit reached takes that edit's evidence with them — a
 * carrier created concurrently from an older view would then be the
 * only account left, and the video would quietly revert. This has to be
 * read before the deletion applies, which is why it is split from
 * writing it back.
 */
export function readStampedVideoConfig(
  carriers: YouTubeEmbedShape[],
): StampedVideoConfig | null {
  const config = resolveVideoConfig(carriers);
  if (config == null) {
    return null;
  }
  const stamps: Record<string, ConfigStamp> = {};
  for (const key of VIDEO_CONFIG_KEYS) {
    let best: ConfigStamp | undefined;
    for (const carrier of carriers) {
      const stamp = readStamps(carrier)[key];
      if (stamp != null && stampBeats(stamp, best)) {
        best = stamp;
      }
    }
    if (best != null) {
      stamps[key] = best;
    }
  }
  return { config, stamps };
}

/** Writes a captured configuration onto every surviving carrier. */
export function restoreStampedVideoConfig(
  editor: Editor,
  videoKey: string,
  captured: StampedVideoConfig,
  /** The page the deletion happened on, which need not be the open one. */
  shapes: readonly TLShape[],
): void {
  const carriers = groupCarriersByVideoKey(shapes).get(videoKey) ?? [];
  const updates = carriers.flatMap((carrier) => {
    const held = readStamps(carrier);
    // Property by property, and only where the captured stamp outranks
    // what the survivor holds. The capture is taken before the record
    // goes, and an edit can land between then and here — the same
    // operation may delete a carrier and then edit a surviving one —
    // so the snapshot is not automatically the newer of the two.
    // Writing it wholesale would drag every property back to the
    // moment of capture, which is the loss this repair exists to
    // prevent, in the other direction.
    const props: Record<string, unknown> = {};
    const revised: Record<string, ConfigStamp> = {};
    for (const key of VIDEO_CONFIG_KEYS) {
      const winning = captured.stamps[key];
      const current = held[key];
      const behind =
        winning != null
          ? // Whole stamps, session id included: two clients editing
            // one property offline from the same counter both write
            // that counter plus one, so a survivor can hold the
            // winning value under the losing session, and a record
            // arriving later whose session sorts between the two would
            // outrank it though it lost to the record just deleted.
            current == null || stampBeats(winning, current)
          : current == null && carrier.props[key] !== captured.config[key];
      if (!behind) {
        continue;
      }
      props[key] = captured.config[key];
      if (winning != null) {
        revised[key] = winning;
      }
    }
    if (Object.keys(props).length === 0) {
      return [];
    }
    return [
      {
        id: carrier.id,
        type: carrier.type,
        props,
        meta: {
          ...carrier.meta,
          videoConfigRev: { ...held, ...revised },
        },
      },
    ];
  });
  if (updates.length === 0) {
    return;
  }
  // Locked as well, for the reason `updateVideoConfig` is.
  editor.run(
    () => {
      editor.updateShapes(updates);
    },
    { ignoreShapeLock: true },
  );
}
