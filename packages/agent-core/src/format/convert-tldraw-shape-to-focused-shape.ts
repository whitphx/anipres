// Mirrors tldraw/agent-template (MIT, © 2024 tldraw Inc.)'s
// [`shared/format/convertTldrawShapeToFocusedShape.ts`](https://github.com/tldraw/agent-template/blob/main/shared/format/convertTldrawShapeToFocusedShape.ts).
// The function name, role (project a tldraw shape into the
// model-facing simplified form), and switch-on-`shape.type` structure
// come from upstream. The supported kinds are narrower (only what
// Anipres' agent perceives today) and `slide` is Anipres-specific.
// See THIRD_PARTY_NOTICES.md at the repo root.
import type { Editor } from "tldraw";
import { compareOrderKeys } from "anipres/models";
import { FocusedColorSchema, type FocusedColor } from "./focused-color.js";
import type { FocusedShape } from "./focused-shape.js";

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
      .sort((a, b) => compareOrderKeys(a.index, b.index))
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
