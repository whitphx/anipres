import {
  Tldraw,
  useEditor,
  useIsToolSelected,
  useTools,
  DefaultToolbar,
  DefaultToolbarContent,
  DefaultImageToolbar,
  TldrawUiMenuItem,
  DefaultKeyboardShortcutsDialog,
  DefaultKeyboardShortcutsDialogContent,
  uniqueId,
  useAtom,
  useValue,
  react,
  createTLUser,
} from "tldraw";
import type {
  Atom,
  TLUiOverrides,
  TLComponents,
  Editor,
  TldrawProps,
  TLStoreSnapshot,
  TLEditorSnapshot,
  TLInstancePageState,
  TLInstancePageStateId,
  TLContent,
  TLShape,
  TLShapeId,
  TLUser,
  TLUserPreferences,
  TLStore,
  TLStoreWithStatus,
} from "tldraw";
import "tldraw/tldraw.css";

import { SlideShapeType } from "./shapes/slide/SlideShape";
import { MediaControlShapeType } from "./shapes/media-control/MediaControlShape";
import { expandShapeIdsWithMediaControlMarkers } from "./shapes/media-control/expand-with-markers";
import { PresentationModeContext } from "./presentation-mode-context";
import { SlideShapeTool } from "./shapes/slide/SlideShapeTool";
import { ThemeImageShapeTool } from "./shapes/theme-image/ThemeImageShapeTool";
import { ThemeImageToolbar } from "./shapes/theme-image/ThemeImageToolbar";
import { YouTubeEmbedShapeType } from "./shapes/youtube-embed/YouTubeEmbedShape";
import { createVideoPlayerLayer } from "./media/VideoPlayerLayer";
import { installVideoLifecycle } from "./media/marker-lifecycle";
import {
  applyPasteRemapToContent,
  canonicalizeContentVideoConfig,
} from "./media/remap-video-keys";
import {
  groupCarriersByVideoKey,
  resolveVideoConfig,
} from "./media/video-anchor";
import { YouTubeEmbedShapeTool } from "./shapes/youtube-embed/YouTubeEmbedShapeTool";
import { YouTubePlayerManager } from "./media/youtube-player-manager";
import { augmentContentWithThemeImageAssets } from "./augmentContentWithThemeImageAssets";
import { ControlPanel } from "./ControlPanel";
import { createModeAwareDefaultComponents } from "./mode-aware-components";
import {
  attachCopyProvenance,
  classifyRemapOperation,
  frameToMetaJson,
  orderKeyBetween,
  parseFrameMeta,
  readCopyProvenance,
  remapContentFrames,
  stripCopyProvenance,
  type CameraZoomFrameAction,
  type CueFrame,
} from "./timeline-model";
import { PresentationManager } from "./presentation-manager";
import {
  applyStoredStepKeyUpdates,
  createDuplicateShapesRemap,
} from "./duplicate-shapes-remap";
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import "./tldraw-overrides.css";

import { customShapeUtils, customBindingUtils } from "./shape-utils";
const customTools = [
  SlideShapeTool,
  ThemeImageShapeTool,
  YouTubeEmbedShapeTool,
];

// Shape types whose embedded content the user can interact with — a
// single click enters editing state on them in presentation mode.
const isInteractiveEmbedShapeType = (type: string) =>
  type === "embed" || type === YouTubeEmbedShapeType;

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

  return useMemo(() => {
    return {
      $stepHotkeyEnabled,
      $presentationModeHotkeyEnabled,
      $presentationMode,
    };
  }, [$stepHotkeyEnabled, $presentationModeHotkeyEnabled, $presentationMode]);
}
export type AnipresAtoms = ReturnType<typeof usePerInstanceAtoms>;

const makeUiOverrides = ({
  $stepHotkeyEnabled,
  $presentationModeHotkeyEnabled,
  $presentationMode,
}: AnipresAtoms): TLUiOverrides => {
  return {
    actions(editor, actions) {
      actions["next-step"] = {
        id: "next-step",
        label: "Next Step",
        kbd: "right",
        onSelect() {
          if (!$stepHotkeyEnabled.get()) {
            return;
          }

          const presentationManager = PresentationManager.get(editor);
          if (presentationManager == null) {
            return;
          }

          presentationManager.moveTo((v) => v + 1);
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

          const presentationManager = PresentationManager.get(editor);
          if (presentationManager == null) {
            return;
          }

          presentationManager.moveTo((v) => v - 1);
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
      tools[ThemeImageShapeTool.id] = {
        id: ThemeImageShapeTool.id,
        icon: "tool-media",
        label: "Theme Image",
        onSelect: () => editor.setCurrentTool(ThemeImageShapeTool.id),
      };
      tools[YouTubeEmbedShapeTool.id] = {
        id: YouTubeEmbedShapeTool.id,
        icon: "tool-embed",
        label: "YouTube",
        onSelect: () => editor.setCurrentTool(YouTubeEmbedShapeTool.id),
      };
      return tools;
    },
    translations: {
      en: {
        "tool.theme-image-toolbar-title": "Theme Image",
        "tool.theme-image-upload": "Upload Image",
        "tool.theme-image-upload-dark": "Upload Dark Theme Image",
        "tool.theme-image-download": "Download Image",
        "tool.theme-image-download-dark": "Download Dark Theme Image",
        "tool.theme-image-sync": "Sync theme edits",
        // Screen readers announce a selected shape via `tool.<type>`;
        // without these the raw key is read out.
        "tool.youtube-embed": "YouTube video",
        "tool.media-control": "Media event",
      },
    },
  };
};

const createComponents = (signals: {
  $currentStepIndex: Atom<number>;
  $presentationMode: Atom<boolean>;
}): TLComponents => {
  const { $currentStepIndex, $presentationMode } = signals;
  return {
    OnTheCanvas: createVideoPlayerLayer($presentationMode),
    TopPanel: () => {
      const editor = useEditor();
      const presentationManager = PresentationManager.get(editor);
      const presentationMode = useValue($presentationMode);
      const currentStepIndex = useValue($currentStepIndex);
      if (presentationManager == null) {
        return null;
      }
      if (presentationMode) {
        return null;
      }
      return (
        <ControlPanel
          editor={editor}
          presentationManager={presentationManager}
          currentStepIndex={currentStepIndex}
          onCurrentStepIndexChange={(newIndex) => {
            presentationManager.moveTo(newIndex);
          }}
          onPresentationModeEnter={() => {
            $presentationMode.set(true);
          }}
        />
      );
    },
    Toolbar: (props) => {
      const presentationMode = useValue($presentationMode);
      const tools = useTools();
      const isSlideToolSelected = useIsToolSelected(tools[SlideShapeTool.id]);
      const isThemeImageToolSelected = useIsToolSelected(
        tools[ThemeImageShapeTool.id],
      );
      const isYouTubeToolSelected = useIsToolSelected(
        tools[YouTubeEmbedShapeTool.id],
      );
      return (
        !presentationMode && (
          <DefaultToolbar {...props}>
            <TldrawUiMenuItem
              {...tools[SlideShapeTool.id]}
              isSelected={isSlideToolSelected}
            />
            <TldrawUiMenuItem
              {...tools[ThemeImageShapeTool.id]}
              isSelected={isThemeImageToolSelected}
            />
            <TldrawUiMenuItem
              {...tools[YouTubeEmbedShapeTool.id]}
              isSelected={isYouTubeToolSelected}
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
          <TldrawUiMenuItem {...tools[ThemeImageShapeTool.id]} />
          <TldrawUiMenuItem {...tools[YouTubeEmbedShapeTool.id]} />
          <DefaultKeyboardShortcutsDialogContent />
        </DefaultKeyboardShortcutsDialog>
      );
    },
    ImageToolbar: () => {
      const presentationMode = useValue($presentationMode);
      if (presentationMode) {
        return null;
      }
      return <ThemeImageToolbar fallback={<DefaultImageToolbar />} />;
    },
  };
};

interface InnerProps {
  onMount: (
    editor: Editor,
    presentationManager: PresentationManager,
  ) => (() => void) | void;
  snapshot?: TLEditorSnapshot | TLStoreSnapshot;
  store?: TLStore | TLStoreWithStatus;
  perInstanceAtoms: AnipresAtoms;
  assetUrls?: TldrawProps["assetUrls"];
  maxAssetSize?: TldrawProps["maxAssetSize"];
  user: TLUser;
}
const Inner = (props: InnerProps) => {
  const {
    onMount,
    snapshot,
    store,
    perInstanceAtoms,
    assetUrls,
    maxAssetSize,
    user,
  } = props;

  const $currentStepIndex = useAtom<number>("current step index", 0);

  const handleMount = (editor: Editor) => {
    const presentationManager = PresentationManager.create(
      editor,
      $currentStepIndex,
    );

    const stopHandlers: (() => void)[] = [];

    stopHandlers.push(installVideoLifecycle(editor));

    // Existing-frame-id set for the beforeCreate safety net below. It is
    // O(page) to build, and editor.duplicateShapes of N framed shapes
    // fires the handler N times synchronously — so the set is cached for
    // the current task (cleared on the next microtask) and extended
    // incrementally with ids the batch keeps. Unlike a live store scan
    // the cache only gains ids, never loses them: a same-task
    // delete-then-recreate reusing a frame id would be spuriously
    // freshened. Accepted — no such synchronous path exists, and the
    // safety net's failure mode is a fresh id, never data loss.
    let existingFrameIdCache: Set<string> | null = null;
    const getExistingFrameIds = (): Set<string> => {
      if (existingFrameIdCache == null) {
        const ids = new Set<string>();
        for (const other of editor.getCurrentPageShapes()) {
          const otherParsed = parseFrameMeta(other.meta?.frame);
          if (otherParsed.kind === "v2" || otherParsed.kind === "v1") {
            ids.add(otherParsed.frame.id);
          }
        }
        existingFrameIdCache = ids;
        queueMicrotask(() => {
          existingFrameIdCache = null;
        });
      }
      return existingFrameIdCache;
    };

    // Relationship-preserving remap for editor.duplicateShapes — the
    // path tldraw's Duplicate action (Cmd/Ctrl+D, context menu) takes,
    // and alt-drag cloning with it (the select tool's Translating state
    // calls duplicateShapes to start a clone). None of them go through
    // putContentOntoCurrentPage. Installed BEFORE the safety net so the
    // net can hand captured copies over during a wrapped call.
    const duplicateShapesRemap = createDuplicateShapesRemap(editor, () =>
      presentationManager.$getTimelineDoc(),
    );
    duplicateShapesRemap.install();

    stopHandlers.push(
      editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
        if (shape.type === SlideShapeType && shape.meta?.frame == null) {
          // Auto attach camera cueFrame to the newly created slide shape
          const doc = presentationManager.$getTimelineDoc();
          let lastCameraTrackId: string | undefined;
          outer: for (let i = doc.steps.length - 1; i >= 0; i--) {
            for (const batch of doc.steps[i].batches) {
              if (batch.frames[0]?.action.type === "cameraZoom") {
                lastCameraTrackId = batch.trackId;
                break outer;
              }
            }
          }
          const cueFrame: CueFrame<CameraZoomFrameAction> = {
            v: 2,
            id: uniqueId(),
            type: "cue",
            stepId: uniqueId(),
            stepOrderKey: orderKeyBetween(
              doc.steps.at(-1)?.orderKey ?? null,
              null,
            ),
            trackId: lastCameraTrackId ?? uniqueId(),
            action: {
              type: "cameraZoom",
              duration: lastCameraTrackId != null ? 1000 : 0,
            },
          };
          return {
            ...shape,
            meta: {
              ...shape.meta,
              frame: frameToMetaJson(cueFrame),
            },
          };
        } else {
          // SAFETY NET for creation paths that bypass BOTH preprocessed
          // mechanisms (putContentOntoCurrentPage for paste, the
          // duplicateShapes wrapper for Duplicate — e.g. alt-drag
          // cloning): freshen duplicated frame identities shape-at-a-time.
          // This cannot preserve relationships among a multi-shape
          // operation.
          const parsed = parseFrameMeta(shape.meta?.frame);
          if (parsed.kind !== "v2") {
            // none: nothing to do; invalid or v1: the derivation
            // diagnoses them.
            return shape;
          }
          if (duplicateShapesRemap.capture(shape.id)) {
            // A wrapped duplicateShapes call is running: the copy passes
            // through untouched and the wrapper rewrites the COMPLETE
            // set relationship-preservingly afterwards.
            return shape;
          }
          const frame = parsed.frame;
          const existingFrameIds = getExistingFrameIds();
          if (!existingFrameIds.has(frame.id)) {
            existingFrameIds.add(frame.id);
            return shape;
          }
          console.warn(
            "anipres: duplicated animation frame reached the beforeCreate safety net; " +
              "identities are freshened per-shape without relationship preservation.",
          );
          const freshened =
            frame.type === "cue"
              ? {
                  ...frame,
                  id: uniqueId(),
                  stepId: uniqueId(),
                  trackId: uniqueId(),
                }
              : { ...frame, id: uniqueId() };
          return {
            ...shape,
            meta: {
              ...shape.meta,
              frame: frameToMetaJson(freshened),
            },
          };
        }
      }),
    );
    // Deletion needs no reconciliation handler: fractional keys are
    // relative, and sub frames of a deleted cue become detached and are
    // surfaced by the derivation (undoing the deletion restores them).

    stopHandlers.push(
      editor.sideEffects.registerBeforeChangeHandler(
        "instance_page_state",
        (_, next) => {
          if (perInstanceAtoms.$presentationMode.get()) {
            next.selectedShapeIds.forEach((id) => {
              const shape = editor.getShape(id);
              if (shape != null && isInteractiveEmbedShapeType(shape.type)) {
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

      if (isInteractiveEmbedShapeType(editingShape.type)) {
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

    stopHandlers.push(
      react("turn off edit tools in presentation mode", () => {
        const presentationMode = perInstanceAtoms.$presentationMode.get();
        if (presentationMode) {
          editor.selectNone();
          editor.setCurrentTool("select");
          // The canvas shows the current step's completed state on
          // entry; playback must match it (see the method's doc). The
          // microtask escapes this react() callback's signal capture:
          // the reconcile reads step/timeline signals, and tracking
          // them here would re-fire this watcher on every navigation
          // while presenting, superseding the live run it just started.
          // The generation guard covers the deferral's other hazard: a
          // run started in the same tick as the entry (e.g. the slidev
          // addon's onMount calling moveTo) has already applied its own
          // fold and fired its step's events live — the entry reconcile
          // must not supersede it.
          const generationAtEntry = presentationManager.currentRunGeneration();
          queueMicrotask(() => {
            if (
              perInstanceAtoms.$presentationMode.get() &&
              presentationManager.isRunCurrent(generationAtEntry)
            ) {
              presentationManager.reconcileMediaToCurrentStep();
            }
          });
        } else {
          // Don't let a video keep playing over the editor after the
          // presentation ends — and don't let a step run still waiting
          // between frames fire its remaining commands afterwards.
          presentationManager.cancelActiveRun();
          YouTubePlayerManager.get(editor).pauseAll();
        }
      }),
    );

    // MONKEY-PATCH: Wrap `editor.getContentFromCurrentPage` to include ThemeImage assets.
    //
    // tldraw's default `getContentFromCurrentPage` only collects assets referenced by
    // the standard `assetId` prop. ThemeImage uses `assetIdLight` and `assetIdDark` instead,
    // so its assets would be missing from clipboard data when copying to another document.
    //
    // WARNING: `getContentFromCurrentPage` is NOT a documented/public tldraw API.
    // It is an internal method on the Editor class that may be renamed, removed, or have
    // its signature changed in future tldraw versions. If that happens, the runtime guard
    // below will detect the breakage and log a warning (copy-paste will still work for
    // standard shapes, but ThemeImage assets won't be transferred across documents).
    //
    // When upgrading tldraw, verify that this monkey-patch still works correctly.
    // See: https://github.com/whitphx/anipres/issues/387
    //
    // The wrapper ALSO stamps copied content with copy-source provenance
    // (an opaque per-mounted-instance token) — the authoritative signal
    // the paste interception below uses to distinguish within-document
    // operations (duplicate, cut/paste move) from external paste. Ids
    // cannot distinguish those:
    // documents created from the same snapshot share every id. The extra
    // top-level property survives tldraw's clipboard serialization (the
    // copy path spreads the content's non-asset properties into the
    // payload and the paste path reconstructs them; verified against the
    // pinned tldraw version) and is stripped again before insertion.
    const copySourceToken = uniqueId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorAsAny = editor as any;
    if (typeof editorAsAny.getContentFromCurrentPage === "function") {
      const editorWithInternal = editor as Editor & {
        getContentFromCurrentPage(
          shapes: TLShapeId[] | TLShape[],
        ): TLContent | undefined;
      };
      const originalGetContent =
        editorWithInternal.getContentFromCurrentPage.bind(editorWithInternal);
      editorWithInternal.getContentFromCurrentPage = (
        shapes: TLShapeId[] | TLShape[],
      ) => {
        const content = originalGetContent(shapes);
        if (!content) return content;
        augmentContentWithThemeImageAssets(content, (id) =>
          editor.getAsset(id),
        );
        // Stamp each copied video's real configuration while the source
        // document is still here to ask: a copy of a later keyframe
        // carries that keyframe's own props, which may be blank, and a
        // paste into another document has nothing to recover them from.
        const canonicalized = canonicalizeContentVideoConfig(
          content,
          (videoKey) =>
            resolveVideoConfig(
              groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
                videoKey,
              ) ?? [],
            ),
        );
        return attachCopyProvenance(canonicalized, copySourceToken);
      };
    } else {
      console.warn(
        "anipres: editor.getContentFromCurrentPage is missing or has an unexpected signature. " +
          "ThemeImage assets (light/dark) will not be included in clipboard data when copying, " +
          "and copied content will carry no copy-source provenance (pastes will be treated as " +
          "external pastes, the safe fallback). " +
          "This is likely caused by a tldraw version upgrade. " +
          "See: https://github.com/whitphx/anipres/issues/387",
      );
    }

    // Copying a video must carry its media events; see
    // expandShapeIdsWithMediaControlMarkers.
    const editorWithGet = editor as Editor & {
      getContentFromCurrentPage?: (
        shapes: TLShapeId[] | TLShape[],
      ) => TLContent | undefined;
    };
    if (typeof editorWithGet.getContentFromCurrentPage === "function") {
      const originalGetContent =
        editorWithGet.getContentFromCurrentPage.bind(editor);
      editorWithGet.getContentFromCurrentPage = (shapes) =>
        originalGetContent(
          expandShapeIdsWithMediaControlMarkers(editor, shapes),
        );
    } else {
      console.warn(
        "anipres: editor.getContentFromCurrentPage is missing or has an unexpected signature. " +
          "Copying a video will not carry its media events.",
      );
    }

    // Content-level paste preprocessing — the PRIMARY duplication/paste
    // mechanism: an order-independent transform over the complete copied
    // content, with operation-scoped identity maps (frame ids keyed by
    // source shape id; stepId/trackId shared among the copies), so
    // relationships among pasted frames are preserved and links to
    // everything outside the operation are severed.
    // `putContentOntoCurrentPage` is public tldraw API; the guard keeps a
    // future signature change from breaking paste (frames would then hit
    // the beforeCreate safety net instead).
    const editorWithPut = editor as Editor & {
      putContentOntoCurrentPage?: (
        content: TLContent,
        options?: object,
      ) => Editor;
    };
    if (typeof editorWithPut.putContentOntoCurrentPage === "function") {
      const originalPutContent =
        editorWithPut.putContentOntoCurrentPage.bind(editor);
      editorWithPut.putContentOntoCurrentPage = (
        content: TLContent,
        options?: object,
      ) => {
        // Copy-source provenance: read it, then strip it so the private
        // property is never persisted as document data.
        const provenance = readCopyProvenance(content);
        content = stripCopyProvenance(content);
        let existingStepKeyUpdates: { stepId: string; key: string }[] = [];
        try {
          const existingFrameIds = new Set<string>();
          const existingStepIds = new Set<string>();
          const existingTrackIds = new Set<string>();
          for (const shape of editor.getCurrentPageShapes()) {
            const parsed = parseFrameMeta(shape.meta?.frame);
            if (parsed.kind !== "v2" && parsed.kind !== "v1") continue;
            existingFrameIds.add(parsed.frame.id);
            if (parsed.kind === "v2" && parsed.frame.type === "cue") {
              existingStepIds.add(parsed.frame.stepId);
              existingTrackIds.add(parsed.frame.trackId);
            }
            if (parsed.kind === "v1" && parsed.frame.type === "cue") {
              existingTrackIds.add(parsed.frame.trackId);
            }
          }
          // Operation kind from copy-source provenance + source-shape
          // existence (duplicate vs move vs external paste) — never from
          // shape-id or animation-id collisions, which cannot distinguish
          // identical-snapshot sibling documents (semantics and
          // limitations: see the provenance module comment).
          const operation = classifyRemapOperation({
            provenance,
            localDocumentToken: copySourceToken,
            sourceShapeIds: content.shapes.map((shape) => shape.id),
            shapeExistsInDocument: (shapeId) =>
              editor.getShape(shapeId as TLShapeId) != null,
          });
          const remap = remapContentFrames({
            shapes: content.shapes.map((shape) => ({
              shapeId: shape.id,
              frameMeta: shape.meta?.frame,
            })),
            existing: {
              frameIds: existingFrameIds,
              stepIds: existingStepIds,
              trackIds: existingTrackIds,
            },
            currentDoc: presentationManager.$getTimelineDoc(),
            operation,
            mintId: uniqueId,
          });
          existingStepKeyUpdates = remap.existingStepKeyUpdates;
          content = applyPasteRemapToContent(content, remap.updatedFrames, {
            operation,
            mintKey: uniqueId,
            resolveSourceConfig: (videoKey) =>
              resolveVideoConfig(
                groupCarriersByVideoKey(editor.getCurrentPageShapes()).get(
                  videoKey,
                ) ?? [],
              ),
          });
        } catch (e) {
          console.warn("anipres: paste frame preprocessing failed:", e);
          existingStepKeyUpdates = [];
        }
        if (existingStepKeyUpdates.length === 0) {
          return originalPutContent(content, options);
        }
        // Collision-run normalization touched existing steps: apply those
        // key rewrites and the paste in ONE transaction. The rewrites are
        // keyed by STORED stepId so they reach split members displayed
        // under synthetic recovery steps too — a walk over the derived
        // doc's batches would miss them and fabricate a divergence.
        editor.run(() => {
          applyStoredStepKeyUpdates(editor, existingStepKeyUpdates);
          originalPutContent(content, options);
        });
        return editor;
      };
    } else {
      console.warn(
        "anipres: editor.putContentOntoCurrentPage is missing or has an unexpected signature. " +
          "Pasted animation frames will be deduplicated per-shape without relationship preservation.",
      );
    }

    onMount?.(editor, presentationManager);

    return () => {
      stopHandlers.forEach((stopHandler) => stopHandler());
    };
  };

  // Identity-stable across re-renders: `getShapeVisibility` is one of
  // the props tldraw DISPOSES AND RECREATES the whole Editor over (it
  // sits unwrapped in the editor-creation `useLayoutEffect` dep list —
  // see
  // https://github.com/tldraw/tldraw/blob/v3.15.5/packages/editor/src/lib/TldrawEditor.tsx#L456-L509).
  // A fresh closure per render turns any re-render of this component —
  // e.g. `useSync` handing over a new store-status wrapper on every
  // WebSocket reconnect — into a full editor remount that clears undo
  // history and tears down the canvas DOM.
  const determineShapeVisibility = useCallback<
    NonNullable<TldrawProps["getShapeVisibility"]>
  >(
    (shape, editor) => {
      // Media-control markers are metadata carriers, never canvas
      // objects: excluding them here removes them from rendering and
      // hit-testing in every mode. Their visual surface is the
      // media-event strip drawn by the YouTube embed shape's component.
      if (shape.type === MediaControlShapeType) {
        return "hidden";
      }

      const presentationMode = perInstanceAtoms.$presentationMode.get();
      if (!presentationMode) {
        return "visible";
      }

      // This callback can be called before `onMount` is called and the refs are set.
      // So we need to get presentationManager here using the editor object passed to this callback
      // instead of relying on the refs that are set in `onMount`.
      // `presentationManager.create` ensures that the same instance is returned for the same editor.
      const presentationManager = PresentationManager.create(
        editor,
        $currentStepIndex,
      );

      const shapeVisibilities =
        presentationManager.$getShapeVisibilitiesInPresentationMode();
      return shapeVisibilities[shape.id] ?? "hidden";
    },
    [perInstanceAtoms, $currentStepIndex],
  );

  return (
    <PresentationModeContext.Provider
      value={perInstanceAtoms.$presentationMode}
    >
      <Tldraw
        onMount={handleMount}
        components={{
          ...createModeAwareDefaultComponents(
            perInstanceAtoms.$presentationMode,
          ),
          ...createComponents({
            $currentStepIndex,
            $presentationMode: perInstanceAtoms.$presentationMode,
          }),
        }}
        overrides={makeUiOverrides(perInstanceAtoms)}
        shapeUtils={customShapeUtils}
        bindingUtils={customBindingUtils}
        tools={customTools}
        getShapeVisibility={determineShapeVisibility}
        maxAssetSize={maxAssetSize}
        options={{
          maxPages: 1,
        }}
        store={store}
        snapshot={snapshot}
        assetUrls={assetUrls}
        user={user}
      />
    </PresentationModeContext.Provider>
  );
};

// IMPORTANT: Memoization is necessary to prevent re-rendering of the entire Tldraw component tree and recreating the editor instance when the most outer `Anipres` component's props change, which typically happens when the current frame index changes in the parent component.
const MemoizedInner = React.memo(Inner);

export interface AnipresProps {
  presentationMode?: boolean;
  onMount?: (editor: Editor, moveTo: (stepIndex: number) => void) => void;
  snapshot?: InnerProps["snapshot"];
  store?: InnerProps["store"];
  assetUrls?: InnerProps["assetUrls"];
  maxAssetSize?: InnerProps["maxAssetSize"];
  stepHotkeyEnabled?: boolean;
  colorScheme?: "light" | "dark" | "system";
}
export interface AnipresRef {
  rerunStep: () => void;
}
export const Anipres = React.forwardRef<AnipresRef, AnipresProps>(
  (props, ref) => {
    const {
      presentationMode,
      onMount,
      snapshot,
      store,
      assetUrls,
      maxAssetSize,
      stepHotkeyEnabled,
      colorScheme,
    } = props;

    const anipresAtoms = usePerInstanceAtoms();
    const {
      $presentationMode,
      $stepHotkeyEnabled,
      $presentationModeHotkeyEnabled,
    } = anipresAtoms;

    const $userPrefs = useAtom<TLUserPreferences>("anipres user prefs", {
      id: uniqueId(),
      colorScheme: colorScheme ?? "system",
    });
    const user = useMemo(
      () =>
        createTLUser({
          userPreferences: $userPrefs,
          setUserPreferences: (prefs) => $userPrefs.set(prefs),
        }),
      [$userPrefs],
    );
    useEffect(() => {
      $userPrefs.set({
        ...$userPrefs.get(),
        colorScheme: colorScheme ?? "system",
      });
    }, [$userPrefs, colorScheme]);

    useEffect(() => {
      $stepHotkeyEnabled.set(stepHotkeyEnabled ?? true);
    }, [$stepHotkeyEnabled, stepHotkeyEnabled]);

    useEffect(() => {
      $presentationModeHotkeyEnabled.set(presentationMode == null);
    }, [$presentationModeHotkeyEnabled, presentationMode]);

    useEffect(() => {
      if (presentationMode != null) {
        $presentationMode.set(presentationMode);
      }
    }, [$presentationMode, presentationMode]);

    const editorAndSignalsRef = useRef<{
      editor: Editor;
      presentationManager: PresentationManager;
    } | null>(null);
    const handleMount = useCallback(
      (editor: Editor, presentationManager: PresentationManager) => {
        editorAndSignalsRef.current = {
          editor,
          presentationManager,
        };
        onMount?.(editor, (stepIndex: number) => {
          presentationManager.moveTo(stepIndex);
        });
      },
      [onMount],
    );

    useImperativeHandle(ref, () => ({
      rerunStep: () => {
        if (editorAndSignalsRef.current == null) {
          return;
        }
        const { presentationManager } = editorAndSignalsRef.current;
        presentationManager.rerunStep();
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
        store={store}
        assetUrls={memoizedAssetUrls}
        maxAssetSize={maxAssetSize}
        user={user}
      />
    );
  },
);
Anipres.displayName = "Anipres";
