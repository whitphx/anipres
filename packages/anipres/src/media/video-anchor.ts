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
    const shown = carriers.filter(
      (carrier) => visibilities[carrier.id] !== "hidden",
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
