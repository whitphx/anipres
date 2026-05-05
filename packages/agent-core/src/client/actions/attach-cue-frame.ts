import type { Editor, TLShapeId } from "tldraw";
import {
  cueFrameToJsonObject,
  getCueFrame,
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
      const shapeId = helpers.resolveShapeId(action.shapeId);
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

  const prevShapeId = helpers.resolveShapeId(prevAgentShapeId) as TLShapeId;
  const prevShape = editor.getShape(prevShapeId);
  if (!prevShape) return newTrackId();

  const prevFrame = getCueFrame(prevShape) ?? getFrame(prevShape);
  if (!prevFrame || prevFrame.type !== "cue") return newTrackId();

  return prevFrame.trackId;
}

function nextGlobalIndex(editor: Editor): number {
  const allFrames = getFrames(editor.getCurrentPageShapes());
  const allCueFrames = allFrames.filter((f): f is CueFrame => f.type === "cue");
  return getNextGlobalIndexFromCueFrames(allCueFrames);
}
