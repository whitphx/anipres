import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  useEditor,
  useValue,
} from "tldraw";
import type { Geometry2d } from "tldraw";
import {
  MediaControlShape,
  MediaControlShapeType,
  mediaControlShapeProps,
  MEDIA_CONTROL_SHAPE_SIZE,
  resolveMediaControlTarget,
} from "./MediaControlShape";
import { parseFrameMeta } from "../../timeline-model";
import type { MediaControlCommand } from "../../timeline-model";

const COMMAND_ICONS: Record<MediaControlCommand, string> = {
  play: "▶",
  pause: "⏸",
  stop: "⏹",
  mute: "🔇",
  unmute: "🔊",
  setVolume: "🎚",
};

export class MediaControlShapeUtil extends ShapeUtil<MediaControlShape> {
  static override readonly type = MediaControlShapeType;
  static override readonly props = mediaControlShapeProps;

  override getDefaultProps(): MediaControlShape["props"] {
    return {};
  }

  override canResize() {
    return false;
  }

  override hideResizeHandles() {
    return true;
  }

  override hideRotateHandle() {
    return true;
  }

  override getGeometry(): Geometry2d {
    return new Rectangle2d({
      width: MEDIA_CONTROL_SHAPE_SIZE,
      height: MEDIA_CONTROL_SHAPE_SIZE,
      isFilled: true,
    });
  }

  component(shape: MediaControlShape) {
    return <MediaControlBadge shape={shape} />;
  }

  indicator() {
    return (
      <rect
        width={MEDIA_CONTROL_SHAPE_SIZE}
        height={MEDIA_CONTROL_SHAPE_SIZE}
        rx={MEDIA_CONTROL_SHAPE_SIZE / 2}
        ry={MEDIA_CONTROL_SHAPE_SIZE / 2}
      />
    );
  }
}

// eslint-disable-next-line react-refresh/only-export-components
function MediaControlBadge({ shape }: { shape: MediaControlShape }) {
  const editor = useEditor();
  const orphaned = useValue(
    "media control target",
    () => resolveMediaControlTarget(editor, shape.id) == null,
    [editor, shape.id],
  );

  const parsed = parseFrameMeta(shape.meta?.frame);
  const action =
    parsed.kind === "v2" && parsed.frame.action.type === "mediaControl"
      ? parsed.frame.action
      : null;

  const label = orphaned
    ? "Media control event without a video (place it back onto a video shape)"
    : action != null
      ? `Media control event: ${action.command}`
      : "Media control event without playback data";

  return (
    <HTMLContainer
      id={shape.id}
      style={{
        width: MEDIA_CONTROL_SHAPE_SIZE,
        height: MEDIA_CONTROL_SHAPE_SIZE,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        lineHeight: 1,
        userSelect: "none",
        backgroundColor: "var(--color-panel)",
        color: "var(--color-text-1)",
        border: orphaned
          ? "2px solid var(--color-warn)"
          : "1px solid var(--color-text-3)",
        boxShadow: "var(--shadow-1)",
      }}
      title={label}
      aria-label={label}
    >
      {orphaned || action == null ? "⚠" : COMMAND_ICONS[action.command]}
    </HTMLContainer>
  );
}
