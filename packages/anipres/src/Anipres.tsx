import {
  Tldraw,
  useEditor,
  useIsToolSelected,
  useTools,
  DefaultToolbar,
  DefaultToolbarContent,
  TldrawUiMenuItem,
  DefaultKeyboardShortcutsDialog,
  DefaultKeyboardShortcutsDialogContent,
  computed,
  uniqueId,
  react,
  track,
  useAtom,
  useValue,
  EmbedDefinition,
  DEFAULT_EMBED_DEFINITIONS,
} from "tldraw";
import type {
  TLUiOverrides,
  TLComponents,
  Editor,
  TLShape,
  TldrawProps,
  TLStoreSnapshot,
  TLEditorSnapshot,
  TLInstancePageState,
  TLInstancePageStateId,
} from "tldraw";
import "tldraw/tldraw.css";

import { SlideShapeType, SlideShapeUtil } from "./SlideShapeUtil";
import { SlideShapeTool } from "./SlideShapeTool";
import { ControlPanel } from "./ControlPanel";
import { createModeAwareDefaultComponents } from "./mode-aware-components";
import {
  getOrderedSteps,
  runStep,
  cueFrameToJsonObject,
  getFrame,
  type CameraZoomFrameAction,
  type CueFrame,
  type SubFrame,
  reconcileShapeDeletion,
  getSubFrame,
  subFrameToJsonObject,
} from "./models";
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { YouTubeIframeRegistry } from "./youtube";

import "./tldraw-overrides.css";

const customShapeUtils = [SlideShapeUtil];
const customTools = [SlideShapeTool];
const customEmbeds = DEFAULT_EMBED_DEFINITIONS.map((embed) => {
  if (embed.type === "youtube") {
    return {
      ...embed,
      toEmbedUrl: (url: string) => {
        const embedUrlString = embed.toEmbedUrl(url);
        if (embedUrlString == null) {
          return null;
        }
        const embedUrl = new URL(embedUrlString);
        embedUrl.searchParams.set("enablejsapi", "1");
        embedUrl.searchParams.set("mute", "1"); // Avoid autoplay blocking policy; https://developer.chrome.com/blog/autoplay/
        embedUrl.searchParams.set("origin", window.location.origin);
        return embedUrl.toString();
      },
    };
  }

  return embed;
}) as EmbedDefinition[];

// We use atoms as it's Tldraw's design,
// but we also need to manage these states per instance of Anipres component
// and isolate different instances from each other.
// This hook is used to create such per-instance atoms.
function usePerInstanceAtoms() {
  const $stepHotkeyEnabled = useAtom("steps hotkeys are enabled", true);
  const $presentationModeHotkeyEnabled = useAtom(
    "presentation mode hotkey is enabled",
    true,
  );
  const $presentationMode = useAtom<boolean>("presentation mode", false);
  const $currentStepIndex = useAtom<number>("current step index", 0);

  return useMemo(() => {
    return {
      $stepHotkeyEnabled,
      $presentationModeHotkeyEnabled,
      $presentationMode,
      $currentStepIndex,
    };
  }, [
    $stepHotkeyEnabled,
    $presentationModeHotkeyEnabled,
    $presentationMode,
    $currentStepIndex,
  ]);
}
type PerInstanceAtoms = ReturnType<typeof usePerInstanceAtoms>;

const makeUiOverrides = ({
  $stepHotkeyEnabled,
  $presentationModeHotkeyEnabled,
  $currentStepIndex,
  $presentationMode,
}: PerInstanceAtoms): TLUiOverrides => {
  return {
    actions(editor, actions) {
      const $steps = computed("ordered steps", () => getOrderedSteps(editor));

      actions["next-step"] = {
        id: "next-step",
        label: "Next Step",
        kbd: "right",
        onSelect() {
          if (!$stepHotkeyEnabled.get()) {
            return;
          }

          const steps = $steps.get();
          const currentStepIndex = $currentStepIndex.get();

          const nextStepIndex = currentStepIndex + 1;
          const res = runStep(editor, steps, nextStepIndex);
          if (!res) {
            return;
          }
          $currentStepIndex.set(nextStepIndex);
        },
      };

      actions["prev-step"] = {
        id: "prev-step",
        label: "Previous Step",
        kbd: "left",
        onSelect() {
          if (!$stepHotkeyEnabled.get()) {
            return;
          }

          const steps = $steps.get();
          const currentStepIndex = $currentStepIndex.get();

          const prevStepIndex = currentStepIndex - 1;
          const res = runStep(editor, steps, prevStepIndex);
          if (!res) {
            return;
          }
          $currentStepIndex.set(prevStepIndex);
        },
      };

      actions["toggle-presentation-mode"] = {
        id: "toggle-presentation-mode",
        label: "Toggle Presentation Mode",
        kbd: "p",
        onSelect() {
          if (!$presentationModeHotkeyEnabled.get()) {
            return;
          }

          $presentationMode.set(!$presentationMode.get());
          if ($presentationMode.get()) {
            const orderedSteps = getOrderedSteps(editor);
            const currentStepIndex = $currentStepIndex.get();
            runStep(editor, orderedSteps, currentStepIndex);
          }
        },
      };

      actions["exit-presentation-mode"] = {
        id: "exit-presentation-mode",
        label: "Exit Presentation Mode",
        kbd: "esc",
        onSelect() {
          if (!$presentationModeHotkeyEnabled.get()) {
            return;
          }

          // Only exit if we're already in presentation mode
          if ($presentationMode.get()) {
            $presentationMode.set(false);
          }
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
};

const createComponents = ({
  $currentStepIndex,
  $presentationMode,
}: PerInstanceAtoms): TLComponents => {
  return {
    TopPanel: () => {
      const editor = useEditor();
      const presentationMode = useValue($presentationMode);
      const currentStepIndex = useValue($currentStepIndex);
      if (presentationMode) {
        return null;
      }
      return (
        <ControlPanel
          editor={editor}
          currentStepIndex={currentStepIndex}
          onCurrentStepIndexChange={(newIndex) => {
            $currentStepIndex.set(newIndex);
          }}
          onPresentationModeEnter={() => {
            $presentationMode.set(true);
            const orderedSteps = getOrderedSteps(editor);
            const currentStepIndex = $currentStepIndex.get();
            runStep(editor, orderedSteps, currentStepIndex);
          }}
        />
      );
    },
    Toolbar: (props) => {
      const presentationMode = useValue($presentationMode);
      const tools = useTools();
      const isSlideToolSelected = useIsToolSelected(tools[SlideShapeTool.id]);
      return (
        !presentationMode && (
          <DefaultToolbar {...props}>
            <TldrawUiMenuItem
              {...tools[SlideShapeTool.id]}
              isSelected={isSlideToolSelected}
            />
            <DefaultToolbarContent />
          </DefaultToolbar>
        )
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
};

interface InnerProps {
  onMount: TldrawProps["onMount"];
  snapshot?: TLEditorSnapshot | TLStoreSnapshot;
  perInstanceAtoms: PerInstanceAtoms;
  assetUrls?: TldrawProps["assetUrls"];
}
const Inner = track((props: InnerProps) => {
  const { onMount, snapshot, perInstanceAtoms, assetUrls } = props;

  const handleMount = (editor: Editor) => {
    const stopHandlers: (() => void)[] = [];

    stopHandlers.push(
      editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
        if (shape.type === SlideShapeType && shape.meta?.frame == null) {
          // Auto attach camera cueFrame to the newly created slide shape
          const orderedSteps = getOrderedSteps(editor);
          const lastCameraCueFrame = orderedSteps
            .reverse()
            .flat()
            .find((ab) => ab.data[0].action.type === "cameraZoom");
          const cueFrame: CueFrame<CameraZoomFrameAction> = {
            id: uniqueId(),
            type: "cue",
            globalIndex: orderedSteps.length,
            trackId: lastCameraCueFrame
              ? lastCameraCueFrame.trackId
              : uniqueId(),
            action: {
              type: "cameraZoom",
              duration: lastCameraCueFrame ? 1000 : 0,
            },
          };
          return {
            ...shape,
            meta: {
              ...shape.meta,
              frame: cueFrameToJsonObject(cueFrame),
            },
          };
        } else {
          // If the shape contains a frame, ensure that the frame is unique.
          // This is necessary e.g. when a shape is duplicated, the frame should not be duplicated.
          const frame = getFrame(shape);
          if (frame == null) {
            return shape;
          }

          const allShapes = editor.getCurrentPageShapes();
          const allFrameIds = allShapes.map((shape) => getFrame(shape)?.id);
          if (allFrameIds.includes(frame.id)) {
            const newFrameId = uniqueId();
            const nextSubFrameShape = allShapes.find(
              (shape) => getSubFrame(shape)?.prevFrameId === frame.id,
            );
            if (nextSubFrameShape != null) {
              const nextSubFrame = getSubFrame(nextSubFrameShape)!;
              editor.updateShape({
                ...nextSubFrameShape,
                meta: {
                  ...nextSubFrameShape.meta,
                  frame: subFrameToJsonObject({
                    ...nextSubFrame,
                    prevFrameId: newFrameId,
                  }),
                },
              });
            }
            shape.meta.frame = {
              id: newFrameId,
              type: "sub",
              prevFrameId: frame.id,
              action: frame.action,
            } satisfies SubFrame;
          }
          return shape;
        }
      }),
    );
    stopHandlers.push(
      editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
        reconcileShapeDeletion(editor, shape);
      }),
    );

    stopHandlers.push(
      editor.sideEffects.registerBeforeChangeHandler(
        "instance_page_state",
        (_, next) => {
          if (perInstanceAtoms.$presentationMode.get()) {
            next.selectedShapeIds.forEach((id) => {
              const shape = editor.getShape(id);
              if (shape?.type === "embed") {
                // In presentation mode, editing state is enabled by a single click on an embed shape.
                // Editing state is needed because it's where the user can interact with the embed shape, e.g. controlling a YouTube video.
                if (next.editingShapeId !== id) {
                  editor.setEditingShape(shape);
                }
              }
            });
            return {
              ...next,
              // The readonly flag on `editor` still allows selecting shapes,
              // so we disable it here.
              hoveredShapeId: null,
              selectedShapeIds: [],
              // editingShapeId: null,  // Setting `editingShapeId` here causes an error, so we control it in the `change` event listener below.
              focusedGroupId: null,
              croppingShapeId: null,
              erasingShapeIds: [],
              hintingShapeIds: [],
            };
          }
          return next;
        },
      ),
    );
    editor.addListener("change", (ev) => {
      // See above. We control `editingShapeId` here because setting it in the `beforeChange` handler above causes an error.
      const presentationMode = perInstanceAtoms.$presentationMode.get();
      if (!presentationMode) {
        return;
      }

      const key = "instance_page_state:page:page" as TLInstancePageStateId;
      if (!(key in ev.changes.updated)) {
        return;
      }

      const [, to] = ev.changes.updated[key];
      const editingShapeId = (to as TLInstancePageState).editingShapeId;
      if (editingShapeId == null) {
        return;
      }
      const editingShape = editor.getShape(editingShapeId);
      if (editingShape == null) {
        return;
      }

      if (editingShape.type === "embed") {
        // Editing an embed shape is allowed so that the user can manipulate the content inside the embed.
        return;
      }

      editor.setEditingShape(null);
    });
    editor.addListener("event", (ev) => {
      const presentationMode = perInstanceAtoms.$presentationMode.get();
      if (!presentationMode) {
        return;
      }
      // Cancel double click in presentation mode so that the user can't create a new text.
      if (ev.type === "pointer" && ev.target === "canvas") {
        editor.cancelDoubleClick();
      }
    });

    onMount?.(editor);

    const ytRegistry = new YouTubeIframeRegistry();

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const htmlElement = node as HTMLElement;
            if (
              htmlElement.classList.contains("tl-shape") &&
              htmlElement.dataset.shapeType === "embed"
            ) {
              const iframe = htmlElement.querySelector("iframe");
              if (iframe == null) {
                return;
              }
              const shapeId = iframe.parentElement?.id;
              if (shapeId == null) {
                return;
              }
              ytRegistry.add(shapeId, iframe);

              // ytRegistry.play(shapeId);  // TODO: Call this when necessary.
            }
          }
        });
      });
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
    });

    return () => {
      stopHandlers.forEach((stopHandler) => stopHandler());
      observer.disconnect();
    };
  };

  const determineShapeHidden = (shape: TLShape, editor: Editor): boolean => {
    const presentationMode = perInstanceAtoms.$presentationMode.get();
    const editMode = !presentationMode;
    const HIDDEN = true;
    const SHOW = false;
    if (editMode) {
      return SHOW;
    }

    if (shape.type === SlideShapeType) {
      return HIDDEN;
    }

    if (shape.meta?.hiddenDuringAnimation) {
      return HIDDEN;
    }

    const frame = getFrame(shape);
    if (frame == null) {
      // No animation frame is attached to this shape, so it should always be visible
      return SHOW;
    }

    const orderedSteps = getOrderedSteps(editor); // TODO: Cache
    const currentStepIndex = perInstanceAtoms.$currentStepIndex.get();

    // The last frame of a finished animation should always be visible
    if (frame.type === "cue") {
      const cueFrame = frame;
      const isFuture = cueFrame.globalIndex > currentStepIndex;
      if (isFuture) {
        return HIDDEN;
      }

      const lastBatchIncludingThisTrack = orderedSteps
        .slice(0, currentStepIndex + 1)
        .reverse()
        .flat()
        .find((ab) => ab.trackId === cueFrame.trackId);
      const isLatestPrevInTrack =
        lastBatchIncludingThisTrack &&
        lastBatchIncludingThisTrack.data.findIndex(
          (frame) => frame.id === cueFrame.id,
        ) ===
          lastBatchIncludingThisTrack.data.length - 1;
      if (isLatestPrevInTrack) {
        return SHOW;
      }
    } else if (frame.type === "sub") {
      const subFrame = frame;
      const thisBatch = orderedSteps
        .flat()
        .find((ab) => ab.data.some((frame) => frame.id === subFrame.id));
      if (thisBatch == null) {
        // This should never happen, but just in case
        return HIDDEN;
      }

      const isFuture = thisBatch.globalIndex > currentStepIndex;
      if (isFuture) {
        return HIDDEN;
      }

      const lastBatchIncludingThisTrack = orderedSteps
        .slice(0, currentStepIndex + 1)
        .reverse()
        .flat()
        .find((ab) => ab.trackId === thisBatch.trackId);
      const isLatestPrevInTrack =
        lastBatchIncludingThisTrack &&
        lastBatchIncludingThisTrack.data.findIndex(
          (frame) => frame.id === subFrame.id,
        ) ===
          lastBatchIncludingThisTrack.data.length - 1;
      if (isLatestPrevInTrack) {
        return SHOW;
      }
    }

    return HIDDEN;
  };

  return (
    <Tldraw
      onMount={handleMount}
      components={{
        ...createModeAwareDefaultComponents(perInstanceAtoms.$presentationMode),
        ...createComponents(perInstanceAtoms),
      }}
      overrides={makeUiOverrides(perInstanceAtoms)}
      shapeUtils={customShapeUtils}
      tools={customTools}
      embeds={customEmbeds}
      isShapeHidden={determineShapeHidden}
      options={{
        maxPages: 1,
      }}
      snapshot={snapshot}
      assetUrls={assetUrls}
    />
  );
});

// IMPORTANT: Memoization is necessary to prevent re-rendering of the entire Tldraw component tree and recreating the editor instance when the most outer `Anipres` component's props change, which typically happens when the current frame index changes in the parent component.
const MemoizedInner = React.memo(Inner);

export interface AnipresProps {
  step?: number;
  onStepChange?: (newStep: number) => void;
  presentationMode?: boolean;
  onMount?: InnerProps["onMount"];
  snapshot?: InnerProps["snapshot"];
  assetUrls?: InnerProps["assetUrls"];
  startStep?: number;
}
export interface AnipresRef {
  rerunStep: () => void;
}
export const Anipres = React.forwardRef<AnipresRef, AnipresProps>(
  (props, ref) => {
    const {
      step,
      onStepChange,
      presentationMode,
      onMount,
      snapshot,
      assetUrls,
      startStep = 0,
    } = props;

    const anipresAtoms = usePerInstanceAtoms();
    const {
      $currentStepIndex,
      $presentationMode,
      $stepHotkeyEnabled,
      $presentationModeHotkeyEnabled,
    } = anipresAtoms;

    useEffect(() => {
      $stepHotkeyEnabled.set(step == null);
    }, [$stepHotkeyEnabled, step]);
    useEffect(() => {
      $presentationModeHotkeyEnabled.set(presentationMode == null);
    }, [$presentationModeHotkeyEnabled, presentationMode]);

    const editorRef = useRef<Editor | null>(null);

    const handleMount = useCallback(
      (editor: Editor) => {
        const targetStep = (step ?? 0) + startStep;
        if ($presentationMode.get()) {
          const orderedSteps = getOrderedSteps(editor);
          const res = runStep(editor, orderedSteps, targetStep);
          if (res) {
            $currentStepIndex.set(targetStep);
          }
        }

        editorRef.current = editor;
        onMount?.(editor);
      },
      [step, startStep, onMount, $presentationMode, $currentStepIndex],
    );

    useEffect(() => {
      if (presentationMode != null) {
        $presentationMode.set(presentationMode);
      }
    }, [$presentationMode, presentationMode]);

    useEffect(() => {
      if (step == null) {
        return;
      }
      if ($currentStepIndex.get() === step) {
        return;
      }

      const editor = editorRef.current;
      if (editor == null) {
        return;
      }

      const targetStep = step + startStep;
      const orderedSteps = getOrderedSteps(editor);
      const res = runStep(editor, orderedSteps, targetStep);
      if (res) {
        $currentStepIndex.set(targetStep);
      }
    }, [$currentStepIndex, step, startStep]);
    useEffect(() => {
      if (onStepChange == null) {
        return;
      }

      return react(
        "current frame index to call onCurrentStepIndexChange",
        () => {
          onStepChange($currentStepIndex.get());
        },
      );
    }, [$currentStepIndex, onStepChange]);

    useImperativeHandle(ref, () => ({
      rerunStep: () => {
        if (editorRef.current == null) {
          return;
        }
        runStep(
          editorRef.current,
          getOrderedSteps(editorRef.current),
          $currentStepIndex.get(),
        );
      },
    }));

    const serializedAssetUrls = assetUrls ? JSON.stringify(assetUrls) : null;
    const memoizedAssetUrls = useMemo(
      () => (serializedAssetUrls ? JSON.parse(serializedAssetUrls) : null),
      [serializedAssetUrls],
    );

    return (
      <MemoizedInner
        onMount={handleMount}
        perInstanceAtoms={anipresAtoms}
        snapshot={snapshot}
        assetUrls={memoizedAssetUrls}
      />
    );
  },
);
Anipres.displayName = "Anipres";
