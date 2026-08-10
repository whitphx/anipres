// Reading the anchor carrier's rendering context, shared by the player
// layer and by the carriers that must yield their poster to it.

import { Mat, shortAngleDist, useEditor, useValue } from "tldraw";
import type { Atom, Editor, TLShapeId } from "tldraw";
import { useContext } from "react";
import { PresentationModeContext } from "../presentation-mode-context";
import { PresentationManager } from "../presentation-manager";
import {
  groupCarriersByVideoKey,
  resolveAnchorCarrier,
  resolveVideoConfig,
} from "./video-anchor";
import {
  getVideoKey,
  type YouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";
import { getVideoTransitions, transitionProgress } from "./video-transition";

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/** Everything the player container mirrors from its anchor carrier. */
export interface AnchorPlacement {
  videoKey: string;
  anchorShapeId: TLShapeId;
  videoId: string;
  muted: boolean;
  start: number;
  controls: boolean;
  altText: string;
  transform: string;
  width: number;
  height: number;
  clipPath: string;
  opacity: number;
  zIndex: number;
  interactive: boolean;
}

/**
 * The carrier a video's player sits on, or null if it has none.
 *
 * Both readers of this answer go through here — the placement the
 * runtime mounts, and the suppression each carrier applies to its own
 * poster — because they have to agree: a carrier that hides its poster
 * while the player sits elsewhere leaves a hole, and one that paints it
 * while the player sits on it paints over the video.
 */
function anchorCarrierFor(
  editor: Editor,
  videoKey: string,
  carriers: YouTubeEmbedShape[],
  presentationMode: boolean,
): YouTubeEmbedShape | null {
  // A tween outranks the visibility rule, because during one BOTH
  // carriers are hidden: the incoming one explicitly for the length of
  // the animation, the outgoing one by no longer being current. The
  // player is the video's visible representation while its carriers
  // are not.
  const transition = getVideoTransitions(editor)
    .$transitions.get()
    .get(videoKey);
  const travellingTo =
    transition != null
      ? carriers.find((carrier) => carrier.id === transition.toShapeId)
      : null;
  return (
    travellingTo ??
    resolveAnchorCarrier(editor, carriers, {
      presentationMode,
      visibilities: presentationMode
        ? PresentationManager.get(
            editor,
          )?.$getShapeVisibilitiesInPresentationMode()
        : undefined,
    }) ??
    null
  );
}

/**
 * Whether this carrier is the one the player sits on, and so the one
 * whose poster gives way to it.
 */
export function isPlayerAnchor(
  editor: Editor,
  shape: YouTubeEmbedShape,
  presentationMode: boolean,
): boolean {
  const videoKey = getVideoKey(shape);
  // Only this shape's own video is resolved: asking for every
  // placement would make each carrier's render walk every video on
  // the page.
  const carriers = groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
    videoKey,
  );
  if (carriers == null) {
    return false;
  }
  // Resolved config, not the anchor's own props: a carrier added
  // before the URL was submitted has a blank `videoId` of its own,
  // and checking that would leave its poster painted over the live
  // player it is supposed to be yielding to.
  return (
    anchorCarrierFor(editor, videoKey, carriers, presentationMode)?.id ===
      shape.id && (resolveVideoConfig(carriers)?.videoId ?? "") !== ""
  );
}

export function readPlacements(
  editor: Editor,
  presentationMode: boolean,
): AnchorPlacement[] {
  const sorted = editor.getCurrentPageShapesSorted();
  // tldraw's own rendering metadata, so the player stacks and fades the
  // way its carrier would: `index` is the renderer-assigned z-order
  // (hierarchy-aware, not a flat position in the page array) and
  // `opacity` is already multiplied through the ancestors, which a
  // video inside a translucent group depends on.
  const renderingByShapeId = new Map<
    string,
    { index: number; opacity: number }
  >();
  for (const rendering of editor.getRenderingShapes()) {
    renderingByShapeId.set(rendering.id, {
      index: rendering.index,
      opacity: rendering.opacity,
    });
  }

  const transitionStore = getVideoTransitions(editor);
  const transitions = transitionStore.$transitions.get();
  if (transitions.size > 0) {
    // Subscribing to the clock is what makes an in-flight tween
    // recompute this placement per frame.
    transitionStore.$clock.get();
  }
  const now = Date.now();

  const placements: AnchorPlacement[] = [];
  for (const [videoKey, carriers] of groupCarriersByVideoKey(sorted)) {
    const transition = transitions.get(videoKey);
    const anchor = anchorCarrierFor(
      editor,
      videoKey,
      carriers,
      presentationMode,
    );
    // Absent: no anchor means no mounted iframe at all. Nothing mounted
    // is nothing that the media-session channel can restart unseen,
    // which is the invariant the design holds continuously.
    // One configuration per video, read from its owner rather than from
    // whichever carrier the presentation happens to stand on. Reading
    // the anchor would let a keyframe added before the URL was
    // submitted answer "no video" at a step boundary, unmounting the
    // live player and losing its position.
    const config = resolveVideoConfig(carriers);
    if (anchor == null || config == null || config.videoId === "") {
      continue;
    }
    const transform = editor.getShapePageTransform(anchor.id);
    if (transform == null) {
      continue;
    }
    // Transform and size interpolate between the two carriers' STORED
    // values — never rendered state, which is hidden on both sides.
    // Clip is dropped for the duration and opacity follows the incoming
    // carrier's own composition, exactly as the page-level tween clone
    // an ordinary shape gets travels outside any frame's mask.
    const from =
      transition != null
        ? carriers.find((carrier) => carrier.id === transition.fromShapeId)
        : null;
    const progress =
      transition != null ? transitionProgress(transition, now) : 1;
    const fromTransform =
      from != null ? editor.getShapePageTransform(from.id) : null;
    const tweening = transition != null && from != null && progress < 1;
    const placementTransform =
      tweening && fromTransform != null
        ? Mat.toCssString(
            Mat.Compose(
              Mat.Translate(
                lerp(fromTransform.e, transform.e, progress),
                lerp(fromTransform.f, transform.f, progress),
              ),
              // Shortest path: matrix angles wrap at ±π, so lerping them
              // numerically would take a video turning 179°→-179° all
              // the way round instead of the 2° it actually moved.
              Mat.Rotate(
                fromTransform.rotation() +
                  shortAngleDist(
                    fromTransform.rotation(),
                    transform.rotation(),
                  ) *
                    progress,
              ),
            ),
          )
        : Mat.toCssString(transform);
    placements.push({
      videoKey,
      anchorShapeId: anchor.id,
      videoId: config.videoId,
      muted: config.muted,
      start: config.start,
      controls: config.controls,
      altText: config.altText,
      transform: placementTransform,
      width:
        tweening && from != null
          ? lerp(from.props.w, anchor.props.w, progress)
          : anchor.props.w,
      height:
        tweening && from != null
          ? lerp(from.props.h, anchor.props.h, progress)
          : anchor.props.h,
      clipPath: tweening
        ? "none"
        : (editor.getShapeClipPath(anchor.id) ?? "none"),
      opacity: renderingByShapeId.get(anchor.id)?.opacity ?? anchor.opacity,
      zIndex: renderingByShapeId.get(anchor.id)?.index ?? 0,
      // Input belongs to exactly one of the player and its anchored
      // carrier at a time. Presenting, the player holds it whenever the
      // video's own controls are enabled; editing, only while the user
      // has entered the carrier's editing state. A player in flight
      // holds none of it: it is passing over shapes it does not belong
      // to.
      interactive:
        !tweening &&
        (presentationMode
          ? config.controls
          : editor.getEditingShapeId() === anchor.id),
    });
  }
  return placements;
}

/**
 * The shape ids currently anchoring a live player. Their own posters
 * are suppressed: `OnTheCanvas` renders before the shapes in the DOM
 * and equal-z-index siblings stack by DOM order, so a carrier's poster
 * would paint over the player that represents it.
 */
export function useIsPlayerAnchor(
  shape: YouTubeEmbedShape,
  $presentationMode: Atom<boolean> | null,
): boolean {
  const editor = useEditor();
  const presentationMode = useValue(
    "presentation mode",
    () => $presentationMode?.get() ?? false,
    [$presentationMode],
  );
  return useValue(
    "is player anchor",
    () => isPlayerAnchor(editor, shape, presentationMode),
    [editor, presentationMode, shape],
  );
}

export function usePresentationModeAtom(): Atom<boolean> | null {
  return useContext(PresentationModeContext);
}
