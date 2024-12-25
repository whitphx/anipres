import {
  Tldraw,
  useIsToolSelected,
  useTools,
  DefaultToolbar,
  DefaultToolbarContent,
  TldrawUiMenuItem,
  DefaultKeyboardShortcutsDialog,
  DefaultKeyboardShortcutsDialogContent,
  computed,
} from "tldraw";
import type { TLUiOverrides, TLComponents, Editor, TLShape } from "tldraw";
import "tldraw/tldraw.css";

import { SlideShapeUtil } from "./SlideShapeUtil";
import { SlideShapeTool } from "./SlideShapeTool";
import { FramesPanel } from "./FramesPanel";
import {
  getGlobalFrames,
  $currentFrameIndex,
  $presentationMode,
  getKeyframe,
  runFrame,
  getAllKeyframes,
  detatchKeyframe,
} from "./models";
import { setup } from "./debug";

const MyCustomShapes = [SlideShapeUtil];
const MyCustomTools = [SlideShapeTool];

interface CreateUiOverridesOptions {
  enableKeyControls: boolean;
}
function createUiOverrides(options: CreateUiOverridesOptions): TLUiOverrides {
  const { enableKeyControls } = options;
  return {
    actions(editor, actions) {
      if (!enableKeyControls) {
        return actions;
      }

      const $globalFrames = computed("global frames", () =>
        getGlobalFrames(editor)
      );

      actions["next-frame"] = {
        id: "next-frame",
        label: "Next Frame",
        kbd: "right",
        onSelect() {
          const globalFrames = $globalFrames.get();
          const currentFrameIndex = $currentFrameIndex.get();

          const nextFrameIndex = currentFrameIndex + 1;
          const nextFrame = globalFrames[nextFrameIndex];
          if (nextFrame == null) {
            return;
          }

          $currentFrameIndex.set(nextFrameIndex);
          runFrame(editor, nextFrame);
        },
      };

      actions["prev-frame"] = {
        id: "prev-frame",
        label: "Previous Frame",
        kbd: "left",
        onSelect() {
          const globalFrames = $globalFrames.get();
          const currentFrameIndex = $currentFrameIndex.get();

          const prevFrameIndex = currentFrameIndex - 1;
          const prevFrame = globalFrames[prevFrameIndex];
          if (prevFrame == null) {
            return;
          }

          $currentFrameIndex.set(prevFrameIndex);
          runFrame(editor, prevFrame);
        },
      };

      return actions;
    },
    tools(editor, tools) {
      tools.slide = {
        id: SlideShapeTool.id,
        icon: "group",
        label: "Slide",
        kbd: "s",
        onSelect: () => editor.setCurrentTool(SlideShapeTool.id),
      };
      return tools;
    },
  };
}

const components: TLComponents = {
  HelperButtons: FramesPanel,
  Toolbar: (props) => {
    const tools = useTools();
    const isSlideToolSelected = useIsToolSelected(tools[SlideShapeTool.id]);
    return (
      <DefaultToolbar {...props}>
        <TldrawUiMenuItem
          {...tools[SlideShapeTool.id]}
          isSelected={isSlideToolSelected}
        />
        <DefaultToolbarContent />
      </DefaultToolbar>
    );
  },
  KeyboardShortcutsDialog: (props) => {
    const tools = useTools();
    return (
      <DefaultKeyboardShortcutsDialog {...props}>
        <TldrawUiMenuItem {...tools[SlideShapeTool.id]} />
        <DefaultKeyboardShortcutsDialogContent />
      </DefaultKeyboardShortcutsDialog>
    );
  },
};

interface TlanislideProps {
  presentationMode?: boolean;
  enableKeyControls?: boolean;
  onMount?: (opts: { setCurrentFrameIndex: (index: number) => void }) => void;
}
function Tlanislide(props: TlanislideProps) {
  const {
    presentationMode: initPresentationMode = false,
    enableKeyControls = true,
  } = props;

  const handleMount = (editor: Editor) => {
    setup(editor);

    $presentationMode.set(initPresentationMode);

    editor.sideEffects.registerBeforeDeleteHandler("shape", (shape) => {
      detatchKeyframe(editor, shape.id);
    });

    if (props.onMount) {
      const setCurrentFrameIndex = (newFrameIndex: number) => {
        const globalFrames = getGlobalFrames(editor);

        const nextFrame = globalFrames[newFrameIndex];
        if (nextFrame == null) {
          return;
        }

        $currentFrameIndex.set(newFrameIndex);
        runFrame(editor, nextFrame);
      };
      props.onMount({ setCurrentFrameIndex });
    }
  };

  const determineShapeHidden = (shape: TLShape, editor: Editor): boolean => {
    const presentationMode = $presentationMode.get();
    const editMode = !presentationMode;
    const HIDDEN = true;
    const SHOW = false;
    if (editMode) {
      return SHOW;
    }

    if (shape.meta?.hiddenDuringAnimation) {
      return HIDDEN;
    }

    const keyframe = getKeyframe(shape);
    if (keyframe == null) {
      // No animation keyframe is attached to this shape, so it should always be visible
      return SHOW;
    }

    const globalFrames = getGlobalFrames(editor); // TODO: Cache
    const currentFrameIndex = $currentFrameIndex.get();
    const currentFrame = globalFrames[currentFrameIndex];
    if (currentFrame == null) {
      // Fallback: This should never happen, but if it does, show the shape
      return SHOW;
    }

    const isCurrent = currentFrame
      .map((keyframe) => keyframe.id)
      .includes(keyframe.id);
    if (isCurrent) {
      // Current frame should always be visible
      return SHOW;
    }

    // The last frame of a finished animation should always be visible
    const isFuture = keyframe.globalIndex > currentFrameIndex;
    if (isFuture) {
      return HIDDEN;
    }
    const keyframes = getAllKeyframes(editor); // TODO: Cache
    const isLatestPrevInTrack = !keyframes.some(
      (kf) =>
        kf.localBefore === keyframe.id && kf.globalIndex <= currentFrameIndex
    );
    if (isLatestPrevInTrack) {
      return SHOW;
    }

    return HIDDEN;
  };

  return (
    <Tldraw
      onMount={handleMount}
      components={components}
      overrides={createUiOverrides({ enableKeyControls })}
      shapeUtils={MyCustomShapes}
      tools={MyCustomTools}
      isShapeHidden={determineShapeHidden}
    />
  );
}

export default Tlanislide;
