// Which carrier the live player follows, per video.
//
// This is explicit runtime state, never derived from what happens to be
// rendered: during an animated step there is no visible carrier at all
// (runStep hides the incoming frame's carrier for the length of the
// tween, and the outgoing one has stopped being current), so a rule
// reading rendered visibility would lose the anchor exactly when the
// player must keep moving.

import type { Editor, TLShape, TLShapeId } from "tldraw";
import {
  getVideoKey,
  isYouTubeEmbedShape,
  type YouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { parseFrameMeta } from "../timeline-model/parse";

/** Every carrier on the page, grouped by the video they belong to. */
export function groupCarriersByVideoKey(
  shapes: TLShape[],
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
 * One configuration per video, read from its owner.
 *
 * Sharing an identity means sharing a configuration: `url`, `videoId`,
 * `start`, `muted`, `controls` and `altText` describe the video, and two
 * carriers of one `videoKey` disagreeing about `videoId` is incoherent.
 * Resolving at read time rather than mirroring values between records
 * keeps a stale keyframe from ever seating its own snapshot — and keeps
 * the player from being torn down and rebuilt because the carrier under
 * it happened to answer differently.
 */
export function resolveVideoConfig(
  carriers: YouTubeEmbedShape[],
): VideoConfig | null {
  const owner = getConfigOwnerCarrier(carriers);
  if (owner == null) {
    return null;
  }
  return {
    videoId: owner.props.videoId,
    url: owner.props.url,
    start: owner.props.start,
    muted: owner.props.muted,
    controls: owner.props.controls,
    altText: owner.props.altText,
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
    editingShapeId?: TLShapeId | null;
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
  const editingShapeId = options.editingShapeId ?? editor.getEditingShapeId();
  if (editingShapeId != null) {
    const editing = carriers.find((carrier) => carrier.id === editingShapeId);
    if (editing != null) {
      return editing;
    }
  }
  return getDefaultAnchorCarrier(carriers);
}
