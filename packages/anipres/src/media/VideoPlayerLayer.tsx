// The runtime-owned video players.
//
// Rendered as `components.OnTheCanvas`, which sits inside
// `tl-html-layer tl-shapes` — the element carrying the camera
// transform — so a player positioned in page coordinates inherits pan,
// zoom and cameraZoom animation for free, the same way a shape does,
// without the store learning anything about it.
//
// The camera is all that layer provides; the rest of the anchor
// carrier's rendering context is mirrored explicitly below.

import { useEditor, useValue } from "tldraw";
import type { Atom } from "tldraw";
import { useEffect, useRef } from "react";
import { YouTubePlayerManager } from "./youtube-player-manager";
import { readPlacements, type AnchorPlacement } from "./player-placement";

export function createVideoPlayerLayer($presentationMode: Atom<boolean>) {
  return function VideoPlayerLayer() {
    const editor = useEditor();
    const presentationMode = useValue(
      "presentation mode",
      () => $presentationMode.get(),
      [$presentationMode],
    );
    const placements = useValue(
      "video player placements",
      () => readPlacements(editor, presentationMode),
      [editor, presentationMode],
    );

    return (
      <>
        {placements.map((placement) => (
          <VideoPlayer key={placement.videoKey} placement={placement} />
        ))}
      </>
    );
  };
}

// eslint-disable-next-line react-refresh/only-export-components
function VideoPlayer({ placement }: { placement: AnchorPlacement }) {
  const editor = useEditor();
  const { videoKey, videoId, muted, start, controls, altText } = placement;

  // The IFrame API creates and OWNS the player iframe inside this
  // container, so it must never be rendered through React: a
  // React-owned iframe and the widget API both mutate the element, and
  // every re-render then resets the other side's changes — the embed
  // reloads in a loop and the handshake never completes.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container == null || videoId === "") {
      return;
    }
    const host = document.createElement("div");
    container.appendChild(host);
    const manager = YouTubePlayerManager.get(editor);
    manager.register(videoKey, host, {
      videoId,
      muted,
      start,
      controls,
      // "" keeps the API-created iframe's own default title.
      title: altText,
    });
    return () => {
      manager.unregister(videoKey);
      container.replaceChildren();
    };
    // altText is applied only at player creation; retitling must not
    // rebuild the player. Re-anchoring must not either — it changes
    // only the styles applied below, never this effect's inputs, which
    // is what makes the player survive every step boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, videoKey, videoId, muted, start, controls]);

  return (
    <div
      data-video-key={videoKey}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        transformOrigin: "top left",
        transform: placement.transform,
        width: placement.width,
        height: placement.height,
        clipPath: placement.clipPath,
        opacity: placement.opacity,
        zIndex: placement.zIndex,
        pointerEvents: placement.interactive ? "all" : "none",
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: "#1f1f1f",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
