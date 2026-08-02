import { uniqueId, type Editor } from "tldraw";
import {
  deriveTimeline,
  frameToMetaJson,
  orderKeyBetween,
  newTrackId,
  parseFrameMeta,
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

      // A fresh step appended at the end of the presentation.
      const doc = deriveTimeline({
        shapes: editor.getCurrentPageShapes().map((s) => ({
          shapeId: s.id,
          frameMeta: s.meta?.frame,
        })),
        pageId: editor.getCurrentPageId(),
      });
      const cueFrame: CueFrame = {
        v: 2,
        id: shapeId,
        type: "cue",
        trackId,
        stepId: uniqueId(),
        stepOrderKey: orderKeyBetween(doc.steps.at(-1)?.orderKey ?? null, null),
        action: action.action as FrameAction,
      };

      editor.updateShape({
        id: shapeId,
        type: shape.type,
        meta: {
          ...shape.meta,
          frame: frameToMetaJson(cueFrame),
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
  // we'd need to look up its batch's cue, which we don't currently
  // emit from the agent. Defensive fallback to a new track.
  const parsed = parseFrameMeta(prevShape.meta?.frame);
  if (parsed.kind !== "v2" || parsed.frame.type !== "cue") return newTrackId();

  return parsed.frame.trackId;
}
