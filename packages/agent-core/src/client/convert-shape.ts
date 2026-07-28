// Anipres-original: the focused-shape → tldraw-shape direction is
// not in upstream tldraw/agent-template (their action-application
// flow doesn't go through a focused-shape projection on the way back
// out). The forward direction (`tldrawShapeToFocusedShape`) lives at
// `format/convert-tldraw-shape-to-focused-shape.ts` and that file
// carries the upstream attribution.
import { toRichText, uniqueId, type Editor, type TLShapePartial } from "tldraw";
import {
  cueFrameToJsonObject,
  deriveTimelineFromShapes,
  getFrame,
  getStepOrderKeyAfter,
  newStepId,
  newTrackId,
  type CameraZoomFrameAction,
  type CueFrame,
} from "anipres/models";
import type { CreatableShape } from "../format/focused-shape.js";
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
  const allFrames = shapes.map(getFrame).filter((frame) => frame !== undefined);
  const lastCameraCue = [...allFrames]
    .reverse()
    .find(
      (f): f is CueFrame<CameraZoomFrameAction> =>
        f.type === "cue" && f.action.type === "cameraZoom",
    );

  return {
    v: 2,
    id: uniqueId(),
    type: "cue",
    stepId: newStepId(),
    stepOrderKey: getStepOrderKeyAfter(
      deriveTimelineFromShapes(shapes, editor.getCurrentPageId())
        .steps.filter((step) => !step.synthetic)
        .at(-1)
        ?.batches.flatMap((batch) => batch.frames)
        .map((frame) => editor.getShape(frame.shapeId))
        .map((candidate) => (candidate ? getFrame(candidate) : undefined))
        .find((frame) => frame?.type === "cue")?.stepOrderKey,
    ),
    trackId: lastCameraCue?.trackId ?? newTrackId(),
    action: {
      type: "cameraZoom",
      duration: lastCameraCue ? 1000 : 0,
    },
  };
}
