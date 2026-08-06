import { type TLShape, type TLShapeId, EASINGS, createShapeId } from "tldraw";
import type {
  RuntimeFrame,
  RuntimeStep,
} from "../timeline-model/runtime-steps";
import { resolveMediaControlTarget } from "../shapes/media-control/MediaControlShape";
import { YouTubePlayerManager } from "../media/youtube-player-manager";
import { PresentationManager } from "./presentation-manager";

async function runFrames(
  presentationManager: PresentationManager,
  frames: RuntimeFrame[],
  predecessorShape: TLShape | null,
  historyStoppingPoint: string,
): Promise<void> {
  const editor = presentationManager.editor;
  for (const frame of frames) {
    const shape = editor.getShape(frame.shapeId as TLShapeId);
    if (shape == null) {
      throw new Error(`Shape not found for frame ${frame.id}`);
    }

    const action = frame.action;

    const { duration = 0 } = action;
    const immediate = duration === 0;

    if (action.type === "mediaControl") {
      // The command targets the marker's parent video, not the marker
      // itself. `duration` still applies below as the wait before the
      // batch's next frame.
      const target = resolveMediaControlTarget(editor, shape.id);
      if (target != null) {
        YouTubePlayerManager.get(editor).command(target.id, action);
      }
    } else if (action.type === "cameraZoom") {
      const { inset = 0, easing = "easeInCubic" } = action;

      editor.stopCameraAnimation();
      const bounds = editor.getShapePageBounds(shape);
      if (!bounds) {
        throw new Error(`Bounds not found for shape ${shape.id}`);
      }
      editor.selectNone();
      editor.zoomToBounds(bounds, {
        inset,
        immediate,
        animation: { duration, easing: EASINGS[easing] },
      });
    } else if (action.type === "shapeAnimation") {
      const { easing = "easeInCubic" } = action;
      editor.selectNone();

      if (predecessorShape == null) {
        predecessorShape = shape;
        continue;
      }

      const predecessorShapePageTransform =
        editor.getShapePageTransform(predecessorShape);
      if (!predecessorShapePageTransform) {
        throw new Error(
          `Page transform not found for predecessor shape ${predecessorShape.id}`,
        );
      }
      const shapePageTransform = editor.getShapePageTransform(shape);
      if (!shapePageTransform) {
        throw new Error(`Page transform not found for shape ${shape.id}`);
      }

      // Create and manipulate a temporary shape for animation.
      // The temp shape is created as a direct child of the page
      // and its x, y, and rotation are calculated in page space.
      const animeShapeId = createShapeId();
      editor.run(
        () => {
          const { x, y, rotation } = predecessorShapePageTransform.decomposed();
          editor.createShape({
            ...predecessorShape,
            x,
            y,
            rotation,
            parentId: editor.getCurrentPageId(),
            id: animeShapeId,
            type: shape.type,
            meta: undefined,
          });
        },
        { history: "ignore", ignoreShapeLock: true },
      );

      // HACK: Changes made by editor.animateShape() can't be ignored by `editor.run(..., { history: "ignore" })`
      // because it's done in the `tick` event listener that is executed after the `editor.run()` returns.
      // So we need to cancel the history records in another `tick` event listener manually.
      const onTick = () => {
        editor.bailToMark(historyStoppingPoint);
      };
      editor.on("tick", onTick);

      const { x, y, rotation } = shapePageTransform.decomposed();
      editor.animateShape(
        {
          ...shape,
          x,
          y,
          rotation,
          parentId: editor.getCurrentPageId(),
          id: animeShapeId,
          meta: undefined,
        },
        {
          immediate,
          animation: {
            duration,
            easing: EASINGS[easing],
          },
        },
      );

      setTimeout(() => {
        editor.run(
          () => {
            editor.deleteShape(animeShapeId);
          },
          { history: "ignore", ignoreShapeLock: true },
        );
        editor.off("tick", onTick);
      }, duration);
    }

    await new Promise((resolve) => setTimeout(resolve, duration));

    predecessorShape = shape;
  }
}

export function runStep(
  presentationManager: PresentationManager,
  steps: RuntimeStep[],
  index: number,
): Promise<void> {
  const step = steps[index];
  if (step == null) {
    console.warn(`No step found at index ${index}`);
    return Promise.resolve();
  }

  const editor = presentationManager.editor;

  const markBeforeAnimation = editor.markHistoryStoppingPoint();

  const promises: Promise<void>[] = [];
  step.forEach((frameBatch) => {
    const predecessorFrameBatch = steps
      .slice(0, index)
      .reverse()
      .flat()
      .find((fb) => fb.trackId === frameBatch.trackId);
    const predecessorLastFrame = predecessorFrameBatch?.data.at(-1);
    const predecessorShape =
      predecessorLastFrame != null
        ? editor.getShape(predecessorLastFrame.shapeId as TLShapeId)
        : null;

    const frames = frameBatch.data;
    const frameShapes = frames
      .map((frame) => editor.getShape(frame.shapeId as TLShapeId))
      .filter((shape) => shape != null);

    editor.run(
      () => {
        editor.updateShapes(
          frameShapes.map((shape) => ({
            id: shape.id,
            type: shape.type,
            meta: {
              ...shape.meta,
              hiddenDuringAnimation: true,
            },
          })),
        );
      },
      { history: "ignore", ignoreShapeLock: true },
    );

    const promise = runFrames(
      presentationManager,
      frames,
      predecessorShape ?? null,
      markBeforeAnimation,
    ).finally(() => {
      editor.run(
        () => {
          editor.updateShapes(
            frameShapes.map((shape) => ({
              id: shape.id,
              type: shape.type,
              meta: {
                ...shape.meta,
                hiddenDuringAnimation: null,
              },
            })),
          );
        },
        { history: "ignore", ignoreShapeLock: true },
      );
      editor.bailToMark(markBeforeAnimation);
    });
    promises.push(promise);
  });

  return Promise.all(promises).then();
}
