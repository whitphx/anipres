import type { Editor } from "tldraw";
import {
  deriveTimeline,
  timelineShapesOf,
  type FrameAction,
} from "anipres/models";
import { resolveMediaControlTarget } from "anipres/schema";
import {
  FocusedEasingSchema,
  type FocusedEasing,
} from "../../format/focused-easing.js";
import type { PerceivedFrameAction } from "../../format/focused-frame-action.js";
import type { PresentationStatePart } from "../../schemas/prompt-part.js";
import { registerPartUtil } from "../part-util.js";

/**
 * Lifts the Anipres presentation timeline out of the editor for the agent
 * to perceive. Each step lists its frame batches; each batch lists its
 * frames (in track order) with their actions. Media frames additionally
 * carry the controlled video's shape id — their own carrier is a marker
 * shape outside the agent's vocabulary.
 */
export const PresentationStatePartUtil =
  registerPartUtil<PresentationStatePart>({
    type: "presentationState",
    getPart({ editor }) {
      return { type: "presentationState", ...summarise(editor) };
    },
  });

function summarise(editor: Editor): {
  totalSteps: number;
  steps: PresentationStatePart["steps"];
} {
  // The same shapes the runtime derives its own timeline from, so the
  // step numbers the agent reasons about are the ones the user sees: a
  // media event whose video has no carrier left occupies no step, and
  // counting it would shift every later step out of line.
  const doc = deriveTimeline({
    shapes: timelineShapesOf(editor, editor.getCurrentPageShapes()).map(
      (shape) => ({
        shapeId: shape.id,
        frameMeta: shape.meta?.frame,
      }),
    ),
  });

  // The timeline labels steps from 0, where the label counts
  // advances, so the agent perceives the same numbers the user reads
  // and a message like "I added a slide as step 7" points at the
  // column they see. The system prompt describes the same vocabulary.
  const steps = doc.steps.map((step, index) => ({
    index,
    batches: step.batches.map((batch) => ({
      trackId: batch.trackId,
      frames: batch.frames.map((frame) => {
        // A mediaControl frame's carrier is a marker shape, which the
        // agent can't resolve itself — markers aren't in its shape
        // vocabulary. A video that moves is several carriers, so this
        // names a representative one of them rather than the video,
        // deterministically, so the agent can talk about which video a
        // command belongs to.
        const target =
          frame.action.type === "mediaControl"
            ? resolveMediaControlTarget(editor, frame.shapeId)
            : null;
        return {
          shapeId: frame.shapeId,
          ...(target != null ? { targetShapeId: target.id as string } : {}),
          action: toFocusedFrameAction(frame.action),
        };
      }),
    })),
  }));

  return { totalSteps: doc.steps.length, steps };
}

/**
 * Project a tldraw `FrameAction` (which may use easings outside the agent's
 * vocabulary) into a `PerceivedFrameAction` (a subset). Easings the agent
 * doesn't recognise are dropped — the agent just sees an action without an
 * `easing` field, which is fine; the editor will fall back to its default.
 */
function toFocusedFrameAction(action: FrameAction): PerceivedFrameAction {
  if (action.type === "mediaControl") {
    return {
      type: "mediaControl",
      command: action.command,
      duration: action.duration,
      volume: action.volume,
    };
  }
  const easing = coerceEasing(action.easing);
  if (action.type === "cameraZoom") {
    return {
      type: "cameraZoom",
      duration: action.duration,
      inset: action.inset,
      ...(easing && { easing }),
    };
  }
  return {
    type: "shapeAnimation",
    duration: action.duration,
    ...(easing && { easing }),
  };
}

function coerceEasing(raw: string | undefined): FocusedEasing | undefined {
  if (raw === undefined) return undefined;
  const result = FocusedEasingSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}
