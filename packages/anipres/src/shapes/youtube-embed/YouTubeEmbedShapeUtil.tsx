import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  stopEventPropagation,
  toDomPrecision,
  useEditor,
  useValue,
} from "tldraw";
import type { Geometry2d, TLShapeId } from "tldraw";
import { useContext, useState } from "react";
import {
  getVideoKey,
  YouTubeEmbedShape,
  YouTubeEmbedShapeType,
  youTubeEmbedShapeProps,
} from "./YouTubeEmbedShape";
import { parseYouTubeUrl } from "./youtube-url";
import {
  useIsPlayerAnchor,
  usePresentationModeAtom,
} from "../../media/player-placement";
import {
  getDefaultAnchorCarrier,
  groupCarriersByVideoKey,
  resolveVideoConfig,
  updateVideoConfig,
} from "../../media/video-anchor";
import {
  MediaControlShapeType,
  resolveMediaControlVideoKey,
} from "../media-control/MediaControlShape";
import { PresentationModeContext } from "../../presentation-mode-context";
import { PresentationManager } from "../../presentation-manager";
import { MEDIA_COMMAND_ICONS, listMediaEvents } from "./media-events";

export class YouTubeEmbedShapeUtil extends BaseBoxShapeUtil<YouTubeEmbedShape> {
  static override readonly type = YouTubeEmbedShapeType;
  static override readonly props = youTubeEmbedShapeProps;

  override getDefaultProps(): YouTubeEmbedShape["props"] {
    return {
      w: 480,
      h: 270,
      url: "",
      videoId: "",
      start: 0,
      muted: false,
      controls: true,
      altText: "",
    };
  }

  override canEdit() {
    return true;
  }

  override getGeometry(shape: YouTubeEmbedShape): Geometry2d {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override getAriaDescriptor(shape: YouTubeEmbedShape) {
    return shape.props.altText;
  }

  component(shape: YouTubeEmbedShape) {
    return <YouTubeEmbed shape={shape} />;
  }

  indicator(shape: YouTubeEmbedShape) {
    return (
      <rect
        width={toDomPrecision(shape.props.w)}
        height={toDomPrecision(shape.props.h)}
        rx={4}
        ry={4}
      />
    );
  }

  override toSvg(shape: YouTubeEmbedShape) {
    // Static exports cannot capture a live player; render a placeholder.
    const { w, h } = shape.props;
    const size = Math.min(w, h) * 0.3;
    const cx = w / 2;
    const cy = h / 2;
    return (
      <g>
        <rect width={w} height={h} rx={8} ry={8} fill="#1f1f1f" />
        <polygon
          points={`${cx - size / 3},${cy - size / 2} ${cx - size / 3},${cy + size / 2} ${cx + (size * 2) / 3},${cy}`}
          fill="#ffffff"
        />
      </g>
    );
  }
}

// eslint-disable-next-line react-refresh/only-export-components
function YouTubeEmbed({ shape }: { shape: YouTubeEmbedShape }) {
  const editor = useEditor();
  const { w, h } = shape.props;
  // One configuration per video: a keyframe added before the URL was
  // submitted must still show that video's poster, not an empty form.
  const config = useValue(
    "video config",
    () =>
      resolveVideoConfig(
        groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
          getVideoKey(shape),
        ) ?? [shape],
      ),
    [editor, shape],
  );
  const videoId = config?.videoId ?? "";
  const altText = config?.altText ?? "";
  const $presentationMode = usePresentationModeAtom();
  // The carrier currently anchoring the live player draws nothing: the
  // player *is* its visual. `OnTheCanvas` renders before the shapes in
  // the DOM, so an equal-z-index poster would paint over it.
  const isPlayerAnchor = useIsPlayerAnchor(shape, $presentationMode);

  if (videoId === "") {
    return (
      <HTMLContainer
        id={shape.id}
        style={{
          width: w,
          height: h,
          pointerEvents: "all",
          backgroundColor: "var(--color-low)",
          border: "1px solid var(--color-low-border)",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <YouTubeUrlForm shape={shape} />
      </HTMLContainer>
    );
  }

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: w,
        height: h,
        // Input belongs to exactly one of the player and its anchored
        // carrier at a time. Anchoring hands it to the player so the
        // video's own controls stay reachable through this container,
        // which is still the later DOM sibling; otherwise the carrier
        // keeps it and selecting, dragging and resizing are ordinary
        // canvas gestures.
        pointerEvents: isPlayerAnchor ? "none" : "all",
      }}
    >
      {!isPlayerAnchor && (
        <img
          src={`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`}
          alt={altText !== "" ? altText : "YouTube video"}
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: 8,
            backgroundColor: "#1f1f1f",
            pointerEvents: "none",
          }}
        />
      )}
      <MediaEventStrip shape={shape} />
    </HTMLContainer>
  );
}

// The visual surface for this video's media events: their marker shapes
// are invisible records (see MediaControlShape), so the video draws
// them itself. Navigation-only — clicking a badge selects the marker,
// which highlights its frame in the timeline where editing lives.
// eslint-disable-next-line react-refresh/only-export-components
function MediaEventStrip({ shape }: { shape: YouTubeEmbedShape }) {
  const editor = useEditor();
  const $presentationMode = useContext(PresentationModeContext);
  const presentationMode = useValue(
    "presentation mode",
    () => $presentationMode?.get() ?? false,
    [$presentationMode],
  );
  const events = useValue(
    "media events",
    () => {
      const manager = PresentationManager.get(editor);
      if (manager == null) {
        return [];
      }
      // One strip per video, not per carrier: it hangs off the same
      // carrier the player anchors to by default, so an animated video
      // does not repeat its event badges under every keyframe.
      const carriers = groupCarriersByVideoKey(
        editor.getCurrentPageShapes(),
      ).get(getVideoKey(shape));
      if (
        carriers == null ||
        getDefaultAnchorCarrier(carriers)?.id !== shape.id
      ) {
        return [];
      }
      const videoKey = getVideoKey(shape);
      const markerIds = new Set(
        editor
          .getCurrentPageShapes()
          .filter(
            (candidate) =>
              candidate.type === MediaControlShapeType &&
              resolveMediaControlVideoKey(editor, candidate.id) === videoKey,
          )
          .map((marker) => marker.id as string),
      );
      return listMediaEvents(manager.$getTimelineDoc(), markerIds);
    },
    [editor, shape],
  );
  const selectedShapeIds = useValue(
    "selected shape ids",
    () => editor.getSelectedShapeIds() as string[],
    [editor],
  );

  if (presentationMode || events.length === 0) {
    return null;
  }

  return (
    <div
      onPointerDown={stopEventPropagation}
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 8,
        display: "flex",
        gap: 4,
        pointerEvents: "all",
      }}
    >
      {events.map((event) => {
        const selected = selectedShapeIds.includes(event.markerShapeId);
        return (
          <button
            key={event.markerShapeId}
            type="button"
            aria-label={`Media event: ${event.command} (step ${event.stepIndex})`}
            aria-current={selected ? "true" : undefined}
            onClick={() => {
              editor.select(event.markerShapeId as TLShapeId);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              height: 24,
              padding: "0 8px",
              borderRadius: 12,
              fontSize: 12,
              lineHeight: 1,
              cursor: "pointer",
              backgroundColor: selected
                ? "var(--color-selected)"
                : "var(--color-panel)",
              color: selected
                ? "var(--color-selected-contrast)"
                : "var(--color-text-1)",
              border: "1px solid var(--color-text-3)",
              boxShadow: "var(--shadow-1)",
            }}
          >
            <span aria-hidden="true">{MEDIA_COMMAND_ICONS[event.command]}</span>
            {/* Same numbering as the timeline: the label counts advances. */}
            {event.stepIndex}
          </button>
        );
      })}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
function YouTubeUrlForm({ shape }: { shape: YouTubeEmbedShape }) {
  const editor = useEditor();
  const [value, setValue] = useState(shape.props.url);
  const [invalid, setInvalid] = useState(false);

  const inputId = `youtube-url-${shape.id}`;
  const errorId = `youtube-url-error-${shape.id}`;
  return (
    <form
      onPointerDown={stopEventPropagation}
      // Keep arrow keys etc. inside the input — otherwise they reach the
      // editor and nudge the (selected, not editing) shape.
      onKeyDown={stopEventPropagation}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseYouTubeUrl(value);
        if (parsed == null) {
          setInvalid(true);
          return;
        }
        // Submitting a URL edits the VIDEO, not the keyframe the form
        // happened to be rendered under, so it reaches every carrier of
        // it — which is also what keeps the value alive when the
        // carrier that owns it is deleted.
        updateVideoConfig(editor, getVideoKey(shape), {
          url: value.trim(),
          videoId: parsed.videoId,
          start: parsed.start ?? 0,
        });
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 16,
        width: "100%",
        maxWidth: 360,
      }}
    >
      <label htmlFor={inputId} style={{ color: "var(--color-text-1)" }}>
        YouTube URL
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        placeholder="https://www.youtube.com/watch?v=..."
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
      />
      {invalid && (
        <span id={errorId} role="alert" style={{ color: "var(--color-warn)" }}>
          Not a recognized YouTube URL
        </span>
      )}
      <button type="submit">Embed video</button>
    </form>
  );
}
