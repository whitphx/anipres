// Reading the anchor carrier's rendering context, shared by the player
// layer and by the carriers that must yield their poster to it.

import { Mat, useEditor, useValue } from "tldraw";
import type { Atom, Editor, TLShapeId } from "tldraw";
import { useContext } from "react";
import { PresentationModeContext } from "../presentation-mode-context";
import { PresentationManager } from "../presentation-manager";
import { groupCarriersByVideoKey, resolveAnchorCarrier } from "./video-anchor";
import {
  getVideoKey,
  type YouTubeEmbedShape,
} from "../shapes/youtube-embed/YouTubeEmbedShape";

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

export function readPlacements(
  editor: Editor,
  presentationMode: boolean,
): AnchorPlacement[] {
  // The page's sorted order is what the renderer itself is fed, and it
  // is defined for every shape whether or not it currently renders — so
  // hiding a carrier does not unmoor the player's layering.
  const sorted = editor.getCurrentPageShapesSorted();
  const zIndexByShapeId = new Map<string, number>();
  sorted.forEach((shape, index) => {
    zIndexByShapeId.set(shape.id, index);
  });

  const presentationManager = PresentationManager.get(editor);
  const visibilities = presentationMode
    ? presentationManager?.$getShapeVisibilitiesInPresentationMode()
    : undefined;
  const editingShapeId = editor.getEditingShapeId();

  const placements: AnchorPlacement[] = [];
  for (const [videoKey, carriers] of groupCarriersByVideoKey(sorted)) {
    const anchor = resolveAnchorCarrier(editor, carriers, {
      presentationMode,
      visibilities,
      editingShapeId,
    });
    // Absent: no anchor means no mounted iframe at all. Nothing mounted
    // is nothing that the media-session channel can restart unseen,
    // which is the invariant the design holds continuously.
    if (anchor == null || anchor.props.videoId === "") {
      continue;
    }
    const transform = editor.getShapePageTransform(anchor.id);
    if (transform == null) {
      continue;
    }
    placements.push({
      videoKey,
      anchorShapeId: anchor.id,
      videoId: anchor.props.videoId,
      muted: anchor.props.muted,
      start: anchor.props.start,
      controls: anchor.props.controls,
      altText: anchor.props.altText,
      transform: Mat.toCssString(transform),
      width: anchor.props.w,
      height: anchor.props.h,
      clipPath: editor.getShapeClipPath(anchor.id) ?? "none",
      opacity: anchor.opacity,
      zIndex: zIndexByShapeId.get(anchor.id) ?? 0,
      // Input belongs to exactly one of the player and its anchored
      // carrier at a time. Presenting, the player holds it whenever the
      // video's own controls are enabled; editing, only while the user
      // has entered the carrier's editing state.
      interactive: presentationMode
        ? anchor.props.controls
        : editingShapeId === anchor.id,
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
    () => {
      // Only this shape's own video is resolved: asking for every
      // placement would make each carrier's render walk every video on
      // the page.
      const carriers = groupCarriersByVideoKey(
        editor.getCurrentPageShapes(),
      ).get(getVideoKey(shape));
      if (carriers == null) {
        return false;
      }
      const anchor = resolveAnchorCarrier(editor, carriers, {
        presentationMode,
        visibilities: presentationMode
          ? PresentationManager.get(
              editor,
            )?.$getShapeVisibilitiesInPresentationMode()
          : undefined,
      });
      return anchor?.id === shape.id && anchor.props.videoId !== "";
    },
    [editor, presentationMode, shape],
  );
}

export function usePresentationModeAtom(): Atom<boolean> | null {
  return useContext(PresentationModeContext);
}
