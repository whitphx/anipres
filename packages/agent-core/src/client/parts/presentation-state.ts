import type { Editor } from "tldraw";
import { deriveTimeline, type FrameAction } from "anipres/models";
import {
  FocusedEasingSchema,
  type FocusedEasing,
} from "../../format/focused-easing.js";
import type { FocusedFrameAction } from "../../format/focused-frame-action.js";
import type { PresentationStatePart } from "../../schemas/prompt-part.js";
import { registerPartUtil } from "../part-util.js";

/**
 * Lifts the Anipres presentation timeline out of the editor for the agent
 * to perceive. Each step lists its frame batches; each batch lists the
 * shapes (in track order) and their frame actions. Stable shape ids let the
 * agent reference exactly the shapes it sees.
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
  const shapes = editor.getCurrentPageShapes();
  const doc = deriveTimeline({
    shapes: shapes.map((shape) => ({
      shapeId: shape.id,
      frameMeta: shape.meta?.frame,
    })),
    pageId: editor.getCurrentPageId(),
  });

  // 1-indexed: Anipres' UI numbers steps from 1 ("Step 1", "Step 2"
  // …) but the underlying array is 0-based. The agent's perception
  // matches the user-facing numbering so messages like "I added a
  // slide as step 7" line up with what the user sees in the
  // timeline; the system prompt also describes steps as 1-numbered
  // to keep the vocabulary consistent.
  const steps = doc.steps.map((step, zeroBased) => ({
    index: zeroBased + 1,
    batches: step.batches.map((batch) => ({
      trackId: batch.trackId,
      shapeIds: batch.frames.map((frame) => frame.shapeId),
      frameAction: toFocusedFrameAction(batch.frames[0].action),
    })),
  }));

  return { totalSteps: doc.steps.length, steps };
}

/**
 * Project a tldraw `FrameAction` (which may use easings outside the agent's
 * vocabulary) into a `FocusedFrameAction` (a subset). Easings the agent
 * doesn't recognise are dropped — the agent just sees an action without an
 * `easing` field, which is fine; the editor will fall back to its default.
 */
function toFocusedFrameAction(action: FrameAction): FocusedFrameAction {
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
