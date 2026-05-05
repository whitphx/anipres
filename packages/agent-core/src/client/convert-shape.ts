import { toRichText, type Editor, type TLShapePartial } from "tldraw";
import {
  FocusedColorSchema,
  type FocusedColor,
  type FocusedShape,
} from "../schemas/actions.js";
import type { AgentHelpers } from "./agent-helpers.js";

/**
 * Convert an agent-emitted FocusedShape into a partial tldraw shape ready for
 * `editor.createShape(...)`. Returns `null` if the shape kind is unrecognised.
 */
export function focusedShapeToTldrawShape(
  shape: FocusedShape,
  helpers: AgentHelpers,
): TLShapePartial | null {
  switch (shape._type) {
    case "rectangle":
      return {
        id: helpers.resolveShapeId(shape.shapeId),
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
  }
}

/**
 * Project a tldraw shape into a FocusedShape so the agent can perceive it.
 * Returns `null` for shapes the agent doesn't model — those are dropped from
 * the perception layer in v0.
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
    if (props.geo !== "rectangle") return null;

    const color = coerceColor(props.color);
    return {
      _type: "rectangle",
      shapeId: shape.id,
      x: shape.x,
      y: shape.y,
      w: props.w,
      h: props.h,
      color,
      text: richTextToPlainText(props.richText),
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
