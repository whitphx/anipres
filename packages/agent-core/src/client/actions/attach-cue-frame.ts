import type { Editor } from "tldraw";
import {
  cueFrameToJsonObject,
  getFrame,
  getFrames,
  getNextGlobalIndexFromCueFrames,
  newTrackId,
  type CueFrame,
  type FrameAction,
} from "anipres/models";
import type { AttachCueFrameAction } from "../../schemas/actions.js";
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
      const globalIndex = nextGlobalIndex(editor);

      const cueFrame: CueFrame = {
        id: shapeId,
        type: "cue",
        globalIndex,
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

function nextGlobalIndex(editor: Editor): number {
  const allCueFrames = getFrames(editor.getCurrentPageShapes()).filter(
    (f): f is CueFrame => f.type === "cue",
  );
  return getNextGlobalIndexFromCueFrames(allCueFrames);
}
