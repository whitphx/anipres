import type { Editor } from "tldraw";
import {
  cueFrameToJsonObject,
  deriveTimelineFromShapes,
  getFrame,
  getStepOrderKeyAfter,
  newStepId,
  newTrackId,
  type CueFrame,
  type FrameAction,
} from "anipres/models";
import type { AttachCueFrameAction } from "../../schemas/agent-action.js";
import { registerActionUtil } from "../action-util.js";
import type { AgentHelpers } from "../agent-helpers.js";

export const AttachCueFrameActionUtil =
  registerActionUtil<AttachCueFrameAction>({
    type: "attachCueFrame",
    apply(action, { editor, helpers }) {
      const shapeId = helpers.resolveExistingShapeId(action.shapeId);
      if (!shapeId) {
        console.warn(
          `[attachCueFrame] no shape found for id "${action.shapeId}" — skipping.`,
        );
        return;
      }
      const shape = editor.getShape(shapeId);
      if (!shape) return;

      const trackId = resolveTrackId(editor, action.prevShapeId, helpers);
      const { stepId, stepOrderKey } = nextStepCoordinates(editor);

      const cueFrame: CueFrame = {
        v: 2,
        id: shapeId,
        type: "cue",
        stepId,
        stepOrderKey,
        trackId,
        action: action.action as FrameAction,
      };

      editor.updateShape({
        id: shapeId,
        type: shape.type,
        meta: {
          ...shape.meta,
          frame: cueFrameToJsonObject(cueFrame),
        },
      });
    },
  });

function resolveTrackId(
  editor: Editor,
  prevAgentShapeId: string | undefined,
  helpers: AgentHelpers,
): string {
  if (!prevAgentShapeId) return newTrackId();

  const prevShapeId = helpers.resolveExistingShapeId(prevAgentShapeId);
  if (!prevShapeId) return newTrackId();
  const prevShape = editor.getShape(prevShapeId);
  if (!prevShape) return newTrackId();

  // We only chain off cue frames; if the prev shape carries a sub-frame
  // we'd need to walk back to its root cue, which we don't currently
  // emit from the agent. Defensive fallback to a new track.
  const prevFrame = getFrame(prevShape);
  if (prevFrame?.type !== "cue") return newTrackId();

  return prevFrame.trackId;
}

function nextStepCoordinates(editor: Editor) {
  const shapes = editor.getCurrentPageShapes();
  const timeline = deriveTimelineFromShapes(shapes, editor.getCurrentPageId());
  const lastFrame = timeline.steps.filter((step) => !step.synthetic).at(-1)
    ?.batches[0]?.frames[0];
  const lastShape = lastFrame ? editor.getShape(lastFrame.shapeId) : undefined;
  const lastCue = lastShape ? getFrame(lastShape) : undefined;
  return {
    stepId: newStepId(),
    stepOrderKey: getStepOrderKeyAfter(
      lastCue?.type === "cue" ? lastCue.stepOrderKey : undefined,
    ),
  };
}
