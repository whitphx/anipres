import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  stopEventPropagation,
  toDomPrecision,
  useEditor,
  useIsEditing,
  useValue,
} from "tldraw";
import type { Geometry2d, TLShapeId } from "tldraw";
import { useContext, useEffect, useRef, useState } from "react";
import {
  YouTubeEmbedShape,
  YouTubeEmbedShapeType,
  youTubeEmbedShapeProps,
} from "./YouTubeEmbedShape";
import { parseYouTubeUrl } from "./youtube-url";
import { YouTubePlayerManager } from "../../media/youtube-player-manager";
import { PresentationModeContext } from "../../presentation-mode-context";
import { PresentationManager } from "../../presentation-manager";
import { MediaControlBindingType } from "../media-control/MediaControlBinding";
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
  const isEditing = useIsEditing(shape.id);
  const { w, h, videoId, start, muted, controls, altText } = shape.props;

  // The IFrame API creates and OWNS the player iframe inside this
  // container. It must never be rendered through React: a React-owned
  // iframe and the widget API both mutate the element (src, attributes),
  // and every re-render then resets the other side's changes — the
  // embed reloads in a loop and the player handshake never completes.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container == null || videoId === "") {
      return;
    }
    const host = document.createElement("div");
    container.appendChild(host);
    const manager = YouTubePlayerManager.get(editor);
    manager.register(shape.id, host, {
      videoId,
      muted,
      start,
      controls,
      // "" keeps the API-created iframe's own default title.
      title: altText,
    });
    return () => {
      manager.unregister(shape.id);
      // destroy() removes the player iframe; this catches whatever is
      // left (e.g. the untouched host when the API never loaded).
      container.replaceChildren();
    };
    // altText is applied only at player creation; retitling must not
    // rebuild the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, shape.id, videoId, muted, start, controls]);

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
        // The iframe swallows pointer events, so the shape is only
        // interactive while in editing state — matching tldraw's own
        // embed shape (double-click, or a single click in presentation
        // mode, to interact with the player).
        pointerEvents: isEditing ? "all" : "none",
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: "#1f1f1f",
        }}
      />
      {/* Announceable label while (or in case) the player-owned iframe
          is absent — the container itself must stay free of React
          children. */}
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          whiteSpace: "nowrap",
        }}
      >
        {altText !== "" ? altText : "YouTube video player"}
      </span>
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
      const markerIds = new Set(
        editor
          .getBindingsToShape(shape.id, MediaControlBindingType)
          .map((binding) => binding.fromId as string),
      );
      return listMediaEvents(manager.$getTimelineDoc(), markerIds);
    },
    [editor, shape.id],
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
            aria-label={`Media event: ${event.command} (step ${event.stepIndex + 1})`}
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
            {event.stepIndex + 1}
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
        editor.updateShape<YouTubeEmbedShape>({
          id: shape.id,
          type: shape.type,
          props: {
            url: value.trim(),
            videoId: parsed.videoId,
            start: parsed.start ?? 0,
          },
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
