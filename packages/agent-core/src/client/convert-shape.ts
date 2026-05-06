// `tldrawShapeToFocusedShape` — name, role (project a tldraw shape
// into the model-facing simplified form), and switch-on-`shape.type`
// structure come from tldraw/agent-template (MIT, © 2024 tldraw
// Inc.)'s
// [`shared/format/convertTldrawShapeToFocusedShape.ts`](https://github.com/tldraw/agent-template/blob/main/shared/format/convertTldrawShapeToFocusedShape.ts).
// The supported shape kinds and the inverse direction
// (`focusedShapeToTldrawShape`, plus the slide / cameraZoom auto-cue
// handling) are Anipres-specific. The pattern of having a focused
// shape vocabulary distinct from tldraw's full schema, with a
// projection function, is upstream's. See THIRD_PARTY_NOTICES.md at
// the repo root.
import { toRichText, uniqueId, type Editor, type TLShapePartial } from "tldraw";
import {
  cueFrameToJsonObject,
  newTrackId,
  getCueFrame,
  getFrames,
  getNextGlobalIndexFromCueFrames,
  type CameraZoomFrameAction,
  type CueFrame,
} from "anipres/models";
import {
  FocusedColorSchema,
  type CreatableShape,
  type FocusedColor,
  type FocusedShape,
} from "../schemas/actions.js";
import type { AgentHelpers } from "./agent-helpers.js";

/**
 * Convert an agent-emitted CreatableShape into a partial tldraw shape ready
 * for `editor.createShape(...)`. For slides, also attaches a `cameraZoom`
 * cue frame — mirroring the side-effect handler the React `Anipres`
 * component installs in its `onMount`.
 */
export function focusedShapeToTldrawShape(
  shape: CreatableShape,
  helpers: AgentHelpers,
): TLShapePartial {
  switch (shape._type) {
    case "rectangle":
      return {
        id: helpers.resolveNewShapeId(shape.shapeId),
        type: "geo",
        x: shape.x,
        y: shape.y,
        props: {
          w: shape.w,
          h: shape.h,
          geo: "rectangle",
          color: shape.color,
          richText: toRichText(shape.text ?? ""),
        },
      };
    case "slide": {
      const id = helpers.resolveNewShapeId(shape.shapeId);
      const cueFrame = buildAutoCameraCueFrame(helpers.editor);
      return {
        id,
        type: "slide",
        x: shape.x,
        y: shape.y,
        props: { w: shape.w, h: shape.h },
        meta: { frame: cueFrameToJsonObject(cueFrame) },
      };
    }
  }
}

/**
 * Mirror of the auto-attach behaviour in `Anipres.tsx`: every slide gets a
 * `cameraZoom` cue frame, reusing the trackId of the most recent existing
 * camera track if there is one (so all slides land on the same track), or
 * starting a new track otherwise. Duration defaults to 1000 ms when there's
 * a predecessor, 0 ms when this is the first camera cue.
 */
function buildAutoCameraCueFrame(
  editor: Editor,
): CueFrame<CameraZoomFrameAction> {
  const shapes = editor.getCurrentPageShapes();
  const allFrames = getFrames(shapes);
  const allCueFrames = shapes
    .map(getCueFrame)
    .filter((f): f is CueFrame => f !== undefined);

  const lastCameraCue = [...allFrames]
    .reverse()
    .find(
      (f): f is CueFrame<CameraZoomFrameAction> =>
        f.type === "cue" && f.action.type === "cameraZoom",
    );

  return {
    id: uniqueId(),
    type: "cue",
    globalIndex: getNextGlobalIndexFromCueFrames(allCueFrames),
    trackId: lastCameraCue?.trackId ?? newTrackId(),
    action: {
      type: "cameraZoom",
      duration: lastCameraCue ? 1000 : 0,
    },
  };
}

/**
 * Project a tldraw shape into a FocusedShape so the agent can perceive it.
 * Returns `null` for shape kinds the agent doesn't model.
 */
export function tldrawShapeToFocusedShape(
  editor: Editor,
  shapeId: string,
): FocusedShape | null {
  const shape = editor.getShape(shapeId as Parameters<Editor["getShape"]>[0]);
  if (!shape) return null;

  if (shape.type === "geo") {
    const props = shape.props as {
      w: number;
      h: number;
      geo: string;
      color: string;
      richText?: unknown;
    };
    const text = richTextToPlainText(props.richText);
    const color = coerceColor(props.color);
    if (props.geo === "rectangle") {
      return {
        _type: "rectangle",
        shapeId: shape.id,
        x: shape.x,
        y: shape.y,
        w: props.w,
        h: props.h,
        color,
        text,
      };
    }
    if (props.geo === "ellipse" || props.geo === "oval") {
      return {
        _type: "ellipse",
        shapeId: shape.id,
        x: shape.x,
        y: shape.y,
        w: props.w,
        h: props.h,
        color,
        text,
      };
    }
    return null;
  }

  if (shape.type === "line") {
    const props = shape.props as {
      color: string;
      points: Record<
        string,
        { id: string; index: string; x: number; y: number }
      >;
    };
    const points = Object.values(props.points)
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
      .map(({ x, y }) => ({ x, y }));
    return {
      _type: "line",
      shapeId: shape.id,
      x: shape.x,
      y: shape.y,
      color: coerceColor(props.color),
      points,
    };
  }

  if (shape.type === "arrow") {
    // Tldraw v3 arrow shapes carry their label as `props.text: string`
    // — not a TipTap richText doc the way geo/text/note do. Reading
    // `richText` here would always come back undefined and arrow labels
    // would silently project as empty strings. Verified against
    // @tldraw/tlschema@3.15.5 TLArrowShape props.
    const props = shape.props as {
      color: string;
      start: { x: number; y: number };
      end: { x: number; y: number };
      text?: string;
    };
    return {
      _type: "arrow",
      shapeId: shape.id,
      x: shape.x,
      y: shape.y,
      color: coerceColor(props.color),
      start: { x: props.start.x, y: props.start.y },
      end: { x: props.end.x, y: props.end.y },
      text: props.text ?? "",
    };
  }

  if (shape.type === "text") {
    const props = shape.props as {
      color: string;
      richText?: unknown;
      // text shapes have no w/h until rendered; we omit them
    };
    return {
      _type: "text",
      shapeId: shape.id,
      x: shape.x,
      y: shape.y,
      color: coerceColor(props.color),
      text: richTextToPlainText(props.richText),
    };
  }

  if (shape.type === "slide") {
    const props = shape.props as { w: number; h: number };
    return {
      _type: "slide",
      shapeId: shape.id,
      x: shape.x,
      y: shape.y,
      w: props.w,
      h: props.h,
    };
  }

  return null;
}

function coerceColor(raw: string): FocusedColor {
  const result = FocusedColorSchema.safeParse(raw);
  return result.success ? result.data : "black";
}

function richTextToPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const out: string[] = [];
  walk(doc as RichNode, out);
  return out.join("").trim();
}

interface RichNode {
  type?: string;
  text?: string;
  content?: RichNode[];
}

function walk(node: RichNode, out: string[]): void {
  if (node.type === "text" && typeof node.text === "string") {
    out.push(node.text);
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, out);
  }
}
