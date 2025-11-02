import { EASINGS, uniqueId } from "tldraw";
import type { Editor, JsonObject, TLShape, TLShapeId } from "tldraw";
import {
  OrderedTrackItem,
  reassignGlobalIndexInplace,
} from "./ordered-track-item";
import { EditorSignals } from "./editor-signals";

export interface FrameActionBase extends JsonObject {
  type: string;
}
export interface ShapeAnimationFrameAction extends FrameActionBase {
  type: "shapeAnimation";
  duration?: number;
  easing?: keyof typeof EASINGS;
}
export interface CameraZoomFrameAction extends FrameActionBase {
  type: "cameraZoom";
  inset?: number;
  duration?: number;
  easing?: keyof typeof EASINGS;
}
export type FrameAction = ShapeAnimationFrameAction | CameraZoomFrameAction;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FrameBase {
  id: string;
  type: string;
}
export interface CueFrame<T extends FrameAction = FrameAction>
  extends FrameBase {
  type: "cue";
  globalIndex: OrderedTrackItem["globalIndex"];
  trackId: OrderedTrackItem["trackId"];
  action: T;
}
export interface SubFrame<T extends FrameAction = FrameAction>
  extends FrameBase {
  type: "sub";
  prevFrameId: Frame["id"];
  action: T;
}
export type Frame<T extends FrameAction = FrameAction> =
  | CueFrame<T>
  | SubFrame<T>;

type BatchedFrames<T extends FrameAction = FrameAction> = [
  CueFrame<T>,
  ...SubFrame<T>[],
];

export type FrameBatch<T extends FrameAction = FrameAction> = OrderedTrackItem<
  BatchedFrames<T>
>;

export function cueFrameToJsonObject(cf: CueFrame): JsonObject {
  const { id, type, globalIndex, trackId, action } = cf;
  const obj = { id, type, globalIndex, trackId, action } satisfies JsonObject;
  return obj;
}

export function subFrameToJsonObject(sf: SubFrame): JsonObject {
  const { id, type, prevFrameId, action } = sf;
  const obj = { id, type, prevFrameId, action } satisfies JsonObject;
  return obj;
}

export function frameToJsonObject(frame: Frame): JsonObject {
  if (frame.type === "cue") {
    return cueFrameToJsonObject(frame);
  } else if (frame.type === "sub") {
    return subFrameToJsonObject(frame);
  }
  // @ts-expect-error This should never happen
  throw new Error(`Invalid frame type: ${frame.type}`);
}

function isFrameAction(obj: unknown): obj is FrameAction {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "type" in obj
  );
}

function isCueFrame(obj: unknown): obj is CueFrame {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "id" in obj &&
    "type" in obj &&
    obj.type === "cue" &&
    "globalIndex" in obj &&
    "trackId" in obj &&
    "action" in obj &&
    isFrameAction(obj.action)
  );
}

export function jsonObjectToCueFrame(obj: unknown): CueFrame {
  if (isCueFrame(obj)) {
    return { ...obj };
  }
  throw new Error(
    `Given input is not a valid CueFrame. ${JSON.stringify(obj)}`,
  );
}

function isSubFrame(obj: unknown): obj is SubFrame {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    "id" in obj &&
    "type" in obj &&
    obj.type === "sub" &&
    "prevFrameId" in obj &&
    "action" in obj &&
    isFrameAction(obj.action)
  );
}

function jsonObjectToSubFrame(obj: unknown): SubFrame {
  if (isSubFrame(obj)) {
    return { ...obj };
  }
  throw new Error(
    `Given input is not a valid SubFrame. ${JSON.stringify(obj)}`,
  );
}

export function getNextGlobalIndexFromCueFrames(cueFrames: CueFrame[]): number {
  const globalIndexes = cueFrames.map((cf) => cf.globalIndex);
  return globalIndexes.length > 0 ? Math.max(...globalIndexes) + 1 : 0;
}

export function getNextGlobalIndex(editor: Editor): number {
  const shapes = editor.getCurrentPageShapes();
  const allCueFrames = shapes
    .map(getCueFrame)
    .filter((cueFrame) => cueFrame != null);
  return getNextGlobalIndexFromCueFrames(allCueFrames);
}

function newTrackId(): string {
  // Use a timestamp to make the tracks sorted in the timeline.
  return `track-${Date.now()}-${uniqueId()}`;
}

export function attachCueFrame(
  editor: Editor,
  shapeId: TLShapeId,
  frameAction: FrameAction,
) {
  const cueFrame: CueFrame = {
    id: shapeId,
    type: "cue",
    globalIndex: getNextGlobalIndex(editor),
    trackId: newTrackId(),
    action: frameAction,
  };

  const shape = editor.getShape(shapeId);
  if (shape == null) {
    return;
  }
  editor.updateShape({
    id: shapeId,
    type: shape.type,
    meta: {
      frame: cueFrameToJsonObject(cueFrame),
    },
  });
}

export function getFrame(shape: TLShape): Frame | undefined {
  return getCueFrame(shape) ?? getSubFrame(shape);
}

export function getFrames(shapes: TLShape[]): Frame[] {
  return shapes.map(getFrame).filter((frame) => frame != null);
}

export function getCueFrame(shape: TLShape): CueFrame | undefined {
  return isJsonObject(shape.meta.frame) && shape.meta.frame.type === "cue"
    ? jsonObjectToCueFrame(shape.meta.frame)
    : undefined;
}

export function getSubFrame(shape: TLShape): SubFrame | undefined {
  return isJsonObject(shape.meta.frame) && shape.meta.frame.type === "sub"
    ? jsonObjectToSubFrame(shape.meta.frame)
    : undefined;
}

export function getFrameBatches(frames: Frame[]): FrameBatch[] {
  const cueFrames: CueFrame[] = [];
  const subFrameConnections: Record<string, SubFrame> = {};
  for (const frame of frames) {
    if (frame.type === "cue") {
      cueFrames.push(frame);
    } else if (frame.type === "sub") {
      subFrameConnections[frame.prevFrameId] = frame;
    }
  }

  const frameBatches: FrameBatch[] = [];
  for (const cueFrame of cueFrames) {
    const subFrames: SubFrame[] = [];
    let prevFrameId = cueFrame.id;
    while (prevFrameId != null) {
      const subFrame = subFrameConnections[prevFrameId];
      if (subFrame != null) {
        subFrames.push(subFrame);
        prevFrameId = subFrame.id;
      } else {
        break;
      }
    }

    frameBatches.push({
      id: `batch-${cueFrame.id}`,
      globalIndex: cueFrame.globalIndex,
      trackId: cueFrame.trackId,
      data: [cueFrame, ...subFrames],
    });
  }

  return frameBatches;
}

export function getFramesFromFrameBatches(frameBatches: FrameBatch[]): Frame[] {
  return frameBatches.flatMap((batch) => batch.data);
}

export type Step = FrameBatch[];

export function getShapeByFrameId(
  editor: Editor,
  frameId: Frame["id"],
): TLShape | undefined {
  const shapes = editor.getCurrentPageShapes();
  return shapes.find((shape) => getFrame(shape)?.id === frameId);
}

export function reconcileShapeDeletion(
  editor: Editor,
  editorSignals: EditorSignals,
  deletedShape: TLShape,
) {
  const deletedFrame = getFrame(deletedShape);
  if (deletedFrame == null) {
    return;
  }

  if (deletedFrame.type === "cue") {
    // Reassign globalIndex
    const steps = editorSignals.$getOrderedSteps();
    reassignGlobalIndexInplace(steps);
    steps.forEach((stepFrameBatches) => {
      stepFrameBatches.forEach((frameBatch) => {
        const newGlobalIndex = frameBatch.globalIndex;
        const cueFrame = frameBatch.data[0];
        const shape = getShapeByFrameId(editor, cueFrame.id);
        if (shape == null) {
          return;
        }
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          meta: {
            frame: cueFrameToJsonObject({
              ...cueFrame,
              globalIndex: newGlobalIndex,
            }),
          },
        });
      });
    });
  } else if (deletedFrame.type === "sub") {
    // Reassign prevFrameId
    const shapes = editor.getCurrentPageShapes();
    const allSubFrames = shapes
      .map((shape) => ({ shape, subFrame: getSubFrame(shape) }))
      .filter(({ subFrame }) => subFrame != null) as {
      shape: TLShape;
      subFrame: SubFrame;
    }[];
    allSubFrames.forEach(({ shape, subFrame }) => {
      if (subFrame.prevFrameId === deletedFrame.id) {
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          meta: {
            frame: subFrameToJsonObject({
              ...subFrame,
              prevFrameId: deletedFrame.prevFrameId,
            }),
          },
        });
      }
    });
  }
}
