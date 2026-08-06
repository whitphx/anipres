import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  stopEventPropagation,
  toDomPrecision,
  useEditor,
  useIsEditing,
} from "tldraw";
import type { Geometry2d } from "tldraw";
import { useEffect, useRef, useState } from "react";
import {
  YouTubeEmbedShape,
  YouTubeEmbedShapeType,
  youTubeEmbedShapeProps,
} from "./YouTubeEmbedShape";
import { buildYouTubeEmbedUrl, parseYouTubeUrl } from "./youtube-url";
import { YouTubePlayerManager } from "../../media/youtube-player-manager";

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

  const embedUrl =
    videoId !== ""
      ? buildYouTubeEmbedUrl({
          videoId,
          start,
          muted,
          controls,
          origin: typeof window !== "undefined" ? window.location.origin : null,
        })
      : null;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe == null || embedUrl == null) {
      return;
    }
    const manager = YouTubePlayerManager.get(editor);
    manager.register(shape.id, iframe, { muted });
    return () => {
      manager.unregister(shape.id);
    };
  }, [editor, shape.id, embedUrl, muted]);

  if (embedUrl == null) {
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
      <iframe
        key={embedUrl}
        ref={iframeRef}
        src={embedUrl}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          borderRadius: 8,
          backgroundColor: "#1f1f1f",
        }}
        title={altText !== "" ? altText : "YouTube video player"}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        draggable={false}
      />
    </HTMLContainer>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
function YouTubeUrlForm({ shape }: { shape: YouTubeEmbedShape }) {
  const editor = useEditor();
  const [value, setValue] = useState(shape.props.url);
  const [invalid, setInvalid] = useState(false);

  const inputId = `youtube-url-${shape.id}`;
  return (
    <form
      onPointerDown={stopEventPropagation}
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
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
      />
      {invalid && (
        <span role="alert" style={{ color: "var(--color-warn)" }}>
          Not a recognized YouTube URL
        </span>
      )}
      <button type="submit">Embed video</button>
    </form>
  );
}
