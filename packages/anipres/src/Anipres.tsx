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
import { SlideShapeTool } from "./shapes/slide/SlideShapeTool";
import { ThemeImageShapeTool } from "./shapes/theme-image/ThemeImageShapeTool";
import { ThemeImageToolbar } from "./shapes/theme-image/ThemeImageToolbar";
import { augmentContentWithThemeImageAssets } from "./augmentContentWithThemeImageAssets";
import { ControlPanel } from "./ControlPanel";
import { createModeAwareDefaultComponents } from "./mode-aware-components";
import {
  attachCopyProvenance,
  classifyRemapOperation,
  frameToMetaJson,
  interactiveKeyAbove,
  migrateV1Frames,
  parseFrameMeta,
  readCopyProvenance,
  remapContentFrames,
  stripCopyProvenance,
  type CameraZoomFrameAction,
  type CueFrame,
  type ShapeLegacyFrame,
  type ShapeV2Frame,
} from "./timeline-model";
import { PresentationManager } from "./presentation-manager";
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import "./tldraw-overrides.css";

import { customShapeUtils } from "./shape-utils";
const customTools = [SlideShapeTool, ThemeImageShapeTool];

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

    // One-time v1 -> v2 migration of the loaded document's animation
    // metadata. Deterministic and convergent (see
    // docs/design-animation-data-model.md "Migration from v1"), so it is
    // safe to persist at load even for synced documents; history-ignored.
    {
      const shapes = editor.getCurrentPageShapes();
      const v1Frames: ShapeLegacyFrame[] = [];
      const v2Frames: ShapeV2Frame[] = [];
      for (const shape of shapes) {
        const parsed = parseFrameMeta(shape.meta?.frame);
        if (parsed.kind === "v1") {
          v1Frames.push({ shapeId: shape.id, frame: parsed.frame });
        } else if (parsed.kind === "v2") {
          v2Frames.push({ shapeId: shape.id, frame: parsed.frame });
        }
      }
      if (v1Frames.length > 0) {
        const migration = migrateV1Frames(
          v1Frames,
          v2Frames,
          editor.getCurrentPageId(),
        );
        editor.run(
          () => {
            editor.updateShapes(
              migration.updates.map(({ shapeId, frame }) => {
                const shape = editor.getShape(shapeId as TLShapeId)!;
                return {
                  id: shape.id,
                  type: shape.type,
                  meta: { ...shape.meta, frame: frameToMetaJson(frame) },
                };
              }),
            );
          },
          { history: "ignore" },
        );
        for (const diagnostic of migration.diagnostics) {
          console.warn("anipres: v1 -> v2 migration diagnostic:", diagnostic);
        }
      }
    }

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
            stepOrderKey: interactiveKeyAbove(
              doc.steps.at(-1)?.orderKey ?? null,
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
          // SAFETY NET for creation paths that bypass content insertion
          // (e.g. editor.duplicateShapes): freshen duplicated frame
          // identities shape-at-a-time. This cannot preserve
          // relationships among a multi-shape operation — the
          // putContentOntoCurrentPage preprocessing below is the primary,
          // relationship-preserving mechanism.
          const parsed = parseFrameMeta(shape.meta?.frame);
          if (parsed.kind !== "v2") {
            // none: nothing to do; invalid: the derivation diagnoses it;
            // v1: converted in memory and migrated on next load.
            return shape;
          }
          const frame = parsed.frame;
          const frameIdExists = editor.getCurrentPageShapes().some((other) => {
            const otherParsed = parseFrameMeta(other.meta?.frame);
            return (
              (otherParsed.kind === "v2" || otherParsed.kind === "v1") &&
              otherParsed.frame.id === frame.id
            );
          });
          if (!frameIdExists) {
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
    // NOTE: v1 registered an afterDelete handler here to renumber
    // globalIndexes and re-link sub-frame chains. v2 needs neither:
    // deletion requires zero writes to other shapes (fractional keys are
    // relative; sub frames of a deleted cue become detached and are
    // surfaced by the derivation, so undoing the deletion restores them
    // with no reconciliation).

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

    stopHandlers.push(
      react("turn off edit tools in presentation mode", () => {
        const presentationMode = perInstanceAtoms.$presentationMode.get();
        if (presentationMode) {
          editor.selectNone();
          editor.setCurrentTool("select");
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
    // duplication from external paste. Ids cannot distinguish those:
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
        return attachCopyProvenance(content, copySourceToken);
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
          // Operation kind from copy-source provenance — never from
          // shape-id or animation-id collisions, which cannot distinguish
          // identical-snapshot sibling documents (semantics and
          // limitations: see the provenance module comment).
          const operation = classifyRemapOperation({
            provenance,
            localDocumentToken: copySourceToken,
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
          if (remap.updatedFrames.size > 0) {
            content = {
              ...content,
              shapes: content.shapes.map((shape) => {
                const frame = remap.updatedFrames.get(shape.id);
                return frame != null
                  ? {
                      ...shape,
                      meta: { ...shape.meta, frame: frameToMetaJson(frame) },
                    }
                  : shape;
              }),
            };
          }
        } catch (e) {
          console.warn("anipres: paste frame preprocessing failed:", e);
          existingStepKeyUpdates = [];
        }
        if (existingStepKeyUpdates.length === 0) {
          return originalPutContent(content, options);
        }
        // Collision-run normalization touched existing steps: apply those
        // key rewrites and the paste in ONE transaction.
        editor.run(() => {
          const doc = presentationManager.$getTimelineDoc();
          for (const { stepId, key } of existingStepKeyUpdates) {
            const step = doc.steps.find((s) => s.id === stepId);
            if (step == null) continue;
            for (const batch of step.batches) {
              const cueShape = editor.getShape(
                batch.frames[0].shapeId as TLShapeId,
              );
              if (cueShape == null) continue;
              const parsed = parseFrameMeta(cueShape.meta?.frame);
              if (parsed.kind !== "v2" || parsed.frame.type !== "cue") {
                continue;
              }
              editor.updateShape({
                id: cueShape.id,
                type: cueShape.type,
                meta: {
                  ...cueShape.meta,
                  frame: frameToMetaJson({
                    ...parsed.frame,
                    stepOrderKey: key,
                  }),
                },
              });
            }
          }
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

  const determineShapeVisibility: TldrawProps["getShapeVisibility"] = (
    shape,
    editor,
  ) => {
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
  };

  return (
    <Tldraw
      onMount={handleMount}
      components={{
        ...createModeAwareDefaultComponents(perInstanceAtoms.$presentationMode),
        ...createComponents({
          $currentStepIndex,
          $presentationMode: perInstanceAtoms.$presentationMode,
        }),
      }}
      overrides={makeUiOverrides(perInstanceAtoms)}
      shapeUtils={customShapeUtils}
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
