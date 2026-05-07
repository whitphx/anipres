import type { Editor } from "tldraw";
import {
  getFrameBatches,
  getFrames,
  getGlobalOrder,
  type Frame,
  type FrameAction,
} from "anipres/models";
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
  const frameToShapeId = new Map<Frame["id"], string>();
  for (const shape of shapes) {
    const frame = (shape.meta?.frame as Frame | undefined) ?? null;
    if (frame) frameToShapeId.set(frame.id, shape.id);
  }

  const allFrames = getFrames(shapes);
  const frameBatches = getFrameBatches(allFrames);
  const ordered = getGlobalOrder(frameBatches);

  const steps = ordered.map((batchesAtStep, stepIndex) => ({
    index: stepIndex,
    batches: batchesAtStep.map((batch) => ({
      trackId: batch.trackId,
      shapeIds: batch.data
        .map((f) => frameToShapeId.get(f.id))
        .filter((id): id is string => id !== undefined),
      frameAction: toFocusedFrameAction(batch.data[0].action),
    })),
  }));

  return { totalSteps: ordered.length, steps };
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
