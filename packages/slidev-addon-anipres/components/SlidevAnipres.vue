<script lang="ts">
import { createRoot } from "react-dom/client";
import { setVeauryOptions, applyPureReactInVue } from "veaury";
import {
  Anipres as AnipresReact,
  type AnipresRef as AnipresReactRef,
  type EditorSignals,
} from "anipres";

setVeauryOptions({
  react: {
    createRoot,
  },
});

export default {
  components: {
    // Anipres: applyReactInVue(AnipresReact),
    Anipres: applyPureReactInVue(AnipresReact),
  },
};
</script>

<script setup lang="ts">
// Inspired by slidev-addon-tldraw:
// https://github.com/AlbertBrand/slidev-addon-tldraw/blob/92d1e75228838f368f028ea9a4f07f1cc9ad7bf7/components/Tldraw.vue#L163
import {
  debounce,
  getSnapshot,
  getUserPreferences,
  setUserPreferences,
  type Editor,
  type TLStoreSnapshot,
  type TLEditorAssetUrls,
  type TLTextShape,
  react,
  uniqueId,
} from "tldraw";
import {
  ref,
  useTemplateRef,
  watch,
  computed,
  watchEffect,
  onUnmounted,
  onMounted,
} from "vue";
import {
  useCssVar,
  useStyleTag,
  useElementBounding,
  onClickOutside,
} from "@vueuse/core";
import {
  onSlideEnter,
  onSlideLeave,
  useDarkMode,
  useSlideContext,
} from "@slidev/client";
import { type AnipresAtoms } from "anipres";
import "anipres/anipres.css";
import * as xiaolaiFont from "/@xiaolai-font.ttf";
// @ts-expect-error virtual import
import ALL_SNAPSHOT from "/@slidev-anipres-snapshot";

interface SavedSnapshot {
  document: TLStoreSnapshot;
}

const props = withDefaults(
  defineProps<{
    id: string;
    at?: string | number;
    offset?: number;
    editable?: boolean;
    fontUrls?: Partial<TLEditorAssetUrls["fonts"]>;
    fontUrl?: string; // Short hand for fontUrls.draw
    excalidrawLikeFont?: boolean;
  }>(),
  {
    at: undefined,
    offset: 0,
    editable: true,
    fontUrls: () => ({}),
    fontUrl: undefined,
    excalidrawLikeFont: false,
  },
);

const fontUrls = computed(() => ({
  ...props.fontUrls,
  draw: props.fontUrls.draw ?? props.fontUrl,
}));

const savedSnapshot: SavedSnapshot | undefined = ALL_SNAPSHOT[props.id];

const { isDark } = useDarkMode();
watch(
  isDark,
  (isDark) => {
    setUserPreferences({
      ...getUserPreferences(),
      colorScheme: isDark ? "dark" : "light",
    });
  },
  { immediate: true },
);

const { $scale, $clicks, $clicksContext } = useSlideContext();

const container = useTemplateRef<HTMLElement>("container");

const {
  width: containerWidth,
  height: containerHeight,
  top: containerTop,
  left: containerLeft,
  update: updateContainerBounding,
} = useElementBounding(container);

const isEditing = ref(false);

watch(isEditing, (isEditing) => {
  if (isEditing) {
    // `top` and `left` can be wrong for example when `top` and `left` are captured while the slide is moving during page transition.
    // So we update the bounding rect of the container when it's actually needed.
    updateContainerBounding();
  }
});

function onDblclick() {
  if (props.editable && import.meta.hot && !isEditing.value) {
    isEditing.value = true;
  }
}

const portalContainer = useTemplateRef<HTMLElement>("portalContainer");
onClickOutside(portalContainer, () => {
  isEditing.value = false;
});

// Ref: https://github.com/AlbertBrand/slidev-addon-tldraw/blob/92d1e75228838f368f028ea9a4f07f1cc9ad7bf7/components/Tldraw.vue#L163
const scale = useCssVar("--slide-scale", container);

const anipresRef = useTemplateRef<{
  __veauryReactRef__?: AnipresReactRef;
}>("anipres");
function rerender() {
  if (anipresRef.value && anipresRef.value.__veauryReactRef__) {
    anipresRef.value.__veauryReactRef__.rerunStep();
  }
}

onSlideEnter(() => {
  rerender();
  // An immediate rerender is sometimes not enough to make the slide rerender.
  // So we do a second rerender after a short delay.
  setTimeout(() => {
    rerender();
  }, 300);
});

const totalSteps = ref<number | null>(null);

const handleMount = (
  editor: Editor,
  $editorSignals: EditorSignals,
  anipresAtoms: AnipresAtoms,
) => {
  const stopHandlers: (() => void)[] = [];

  // Save the snapshot when editing
  function save() {
    if (isEditing.value) {
      const { document } = getSnapshot(editor.store);
      import.meta.hot?.send("anipres-snapshot", {
        id: props.id,
        snapshot: { document },
      });
    }
  }
  const debouncedSave = debounce(save, 500);
  stopHandlers.push(
    editor.store.listen(debouncedSave, { source: "user", scope: "document" }),
  );

  // Sync Slidev's click position -> Anipres' step index
  watchEffect(() => {
    anipresAtoms.$currentStepIndex.set(step.value);
  });

  // Get Anipres' total steps
  stopHandlers.push(
    react("total steps", () => {
      totalSteps.value = $editorSignals.getTotalSteps();
    }),
  );

  watch(
    $scale,
    (newScale) => {
      scale.value = String(newScale);

      setTimeout(() => {
        rerender();
      });
      // An immediate rerender is sometimes not enough to make the slide rerender.
      // So we do a second rerender after a short delay.
      setTimeout(() => {
        rerender();
      }, 100);
    },
    { immediate: true },
  );

  // HACK: This is a workaround to correctly set the sizes of text shapes with `autoSize: true`.
  // Tldraw automatically calculates the shape size for text shapes with `autoSize: true`
  // but its result may be incorrect before the container size becomes stable and the font is loaded.
  // So we trigger the text shape size calculation (https://github.com/tldraw/tldraw/blob/7190fa82f20c24bd239f456c6c941ff638f57e9f/packages/tldraw/src/lib/shapes/text/TextShapeUtil.tsx#L196)
  // by updating the shapes.
  const tldrawContainer = editor.getContainer();
  function resetTextAutoSize() {
    setTimeout(() => {
      // This setTimeout is necessary to make the text shape size calculation correct.
      // For example, when the slide goes out of view and then becomes visible again,
      // the container's size changes from zero to non-zero.
      // This setTimeout prevents the text shape size calculation from being done based on the zero size.
      const shapes = editor.getCurrentPageShapes();
      const textShapes = shapes.filter(
        (shape) =>
          shape.type === "text" && (shape as TLTextShape).props.autoSize,
      ) as TLTextShape[];
      const dummyUpdatedShapes = textShapes.map((shape) => ({
        ...shape,
        props: { ...shape.props, scale: shape.props.scale - 0.0001 },
      }));
      editor.updateShapes(dummyUpdatedShapes);
      editor.updateShapes(textShapes); // We don't want to actually update the shapes, so revert the dummy update immediately.
    });
  }

  const observer = new ResizeObserver(resetTextAutoSize);
  observer.observe(tldrawContainer);

  document.fonts.addEventListener("loadingdone", resetTextAutoSize);

  return () => {
    stopHandlers.forEach((stopHandler) => stopHandler());

    observer.disconnect();
    document.fonts.removeEventListener("loadingdone", resetTextAutoSize);
  };
};

// Register the clicks of this component to Slidev.
const step = ref(0);
const clicksId = uniqueId();
function registerClicks() {
  if (totalSteps.value == null) {
    return;
  }

  $clicksContext.unregister(clicksId);

  // XXX: It's important to unregister the click context before calculating the new click info.
  // Otherwise, the new click info will be incorrect as it will be calculated based on the old click context that includes the old click info of this component itself.
  const defaultAt = $clicksContext.currentOffset > 0 ? "+1" : 0; // Set "+1" if another clickable element exists in the slide to display this component after it. Otherwise, set 0 to display this component immediately.
  const at = props.at ?? defaultAt;
  const totalClicks = totalSteps.value - props.offset;
  const clickInfo = $clicksContext.calculateSince(at, totalClicks);

  $clicksContext.register(clicksId, clickInfo);

  step.value = $clicks.value - (clickInfo?.start ?? 0) + props.offset;
}
onMounted(() => {
  registerClicks();
});
watchEffect(() => {
  // XXX: Calling `$clicksContext.register` here causes a warning that is displayed in the dev mode,
  // saying it's unexpected to call `register` after the component is mounted.
  // TODO: Find the better way to do this, e.g. save and load `totalSteps` to call `$clicksContext.register` only in `onMounted`.
  registerClicks();
});
onUnmounted(() => {
  $clicksContext.unregister(clicksId);
});

// Disable the browser's two-finger swipe for page navigation.
// Ref: https://stackoverflow.com/a/56071966
const { load: loadDisableSwipeCss, unload: unloadDisableSwipeCss } =
  useStyleTag(
    `
  html, body {
    overscroll-behavior-x: none;
  }
`,
    { manual: true },
  );
onSlideEnter(() => {
  loadDisableSwipeCss();
});
onSlideLeave(() => {
  unloadDisableSwipeCss();
});

// Mount the Anipres component only when the slide is active.
// Slidev attaches `display: none` to the inactive slides
// so such slides are not rendered and the client DOM size is calculated as 0.
// In such inactive slides, the Tldraw component fails to initialize some shapes, e.g. text as https://github.com/whitphx/anipres/issues/87
// So we mount the Anipres component only after the slide is active,
// while this workaround causes the Anipres component to be displayed with some delay after the slide becomes active.
// Also, we need to keep the Anipres component mounted even after the slide becomes inactive.
// So we use a `isMountedOnce` ref to track the condition.
const isMountedOnce = ref(false);
onSlideEnter(() => {
  isMountedOnce.value = true;
});

// Configure the hand-drawn style font.
const drawStyleFontFamily = computed(() => {
  if (props.excalidrawLikeFont) {
    return `Excalifont-Regular, "${xiaolaiFont.css.family}", ${xiaolaiFont.fontFamilyFallback}, 'tldraw_draw'`;
  }
  return `'tldraw_draw'`;
});

function handleKeyEvent(event: KeyboardEvent) {
  if (isEditing.value) {
    // Prevent key events from being propagated so that Slidev's keyboard shortcuts do not work during editing.
    // However, some shortcuts on Tldraw are captured on `body` so stopping propagation also prevents such shortcuts from working.
    // Technically, it's not possible to turn off only Slidev's shortcuts while keeping Tldraw's shortcuts
    // because Slidev's are captured on `window` and Tldraw's are captured on `body` as below.
    // So, as a second-best option, we only allow modifier key combinations and some special keys to propagate that are often used in Tldraw's shortcuts,
    // Refs:
    // Slidev sets the key event handlers for shortcuts on `window` as below via useMagicKeys and onKeyStroke from `@vueuse/core`,
    // https://github.com/slidevjs/slidev/blob/bc94b3031546482149b254dc9dcfc38ce5616f1e/packages/client/state/storage.ts#L46
    // https://github.com/slidevjs/slidev/blob/bc94b3031546482149b254dc9dcfc38ce5616f1e/packages/client/logic/shortcuts.ts#L51
    // Tldraw sets the key event handlers for shortcuts on `container.ownerDocument.body` as below,
    // https://github.com/tldraw/tldraw/blob/7329b1541236dfdb913223c11d643b7eb134dbb3/packages/tldraw/src/lib/ui/hooks/useKeyboardShortcuts.ts#L39
    // https://github.com/tldraw/tldraw/blob/7329b1541236dfdb913223c11d643b7eb134dbb3/packages/tldraw/src/lib/ui/hooks/useKeyboardShortcuts.ts#L48
    // TODO: Turn off Slidev's shortcuts by using its API when it becomes available as https://github.com/slidevjs/slidev/issues/2316
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.key === "Backspace"
    ) {
      return;
    }
    event.stopPropagation();
  }
}
</script>

<template>
  <div class="container inverse-transform" ref="container">
    <!--
      <Anipres> should be
      - mounted in the body when editing for the edit tools
        such as Tldraw's context menu and keyboard shortcuts
        to work without being obstructed by the Slidev's contents.
      - mounted in the container in the presentation mode
        so that it's actually embedded in the slide to
        move together with the slide during page navigation
        and to be placed in the slide's DOM respecting things like z-index.
    -->
    <Teleport to="body" :disabled="!isEditing">
      <div
        :class="['portal-container', { editing: isEditing }]"
        ref="portalContainer"
        @dblclick="onDblclick"
        @keydown="handleKeyEvent"
        @keypress="handleKeyEvent"
        @keyup="handleKeyEvent"
        :style="[
          isEditing
            ? {
                position: 'absolute',
                width: containerWidth + 'px',
                height: containerHeight + 'px',
                top: containerTop + 'px',
                left: containerLeft + 'px',
              }
            : {
                width: '100%',
                height: '100%',
              },
          {
            opacity: step >= 0 || isEditing ? 1 : 0,
          },
        ]"
      >
        <Anipres
          v-if="isMountedOnce"
          ref="anipres"
          @mount="handleMount"
          :presentationMode="!isEditing"
          :snapshot="savedSnapshot"
          :assetUrls="{ fonts: fontUrls }"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
  Super thanks to https://github.com/AlbertBrand/slidev-addon-tldraw/blob/92d1e75228838f368f028ea9a4f07f1cc9ad7bf7/components/tldraw.css
  It is MIT licensed as below:

  ```
  MIT License

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  ```
*/

/*
  Slides are CSS transformed at parent level, and Tldraw breaks on such transformations.
  Inverse the transformation to make Tldraw work correctly. (note that `all: unset` only partially works)
*/
.container :deep(p) {
  /* Disable Slidev's styles in Anipres */
  margin-top: inherit;
  margin-bottom: inherit;
  line-height: inherit;
}

.inverse-transform {
  width: calc(var(--slide-scale) * 100%);
  height: calc(var(--slide-scale) * 100%);
  transform: scale(calc(1 / var(--slide-scale)));
  transform-origin: top left;
}

.portal-container :deep(.tl-theme__light, .tl-theme__dark) {
  --color-background: rgba(0, 0, 0, 0);
}

.portal-container:not(.editing) :deep(.tl-container__focused) {
  outline: none;
}

:deep(.tl-container) {
  --tl-font-draw: v-bind(drawStyleFontFamily);
}
</style>

<style>
@font-face {
  font-family: "Excalifont-Regular";
  src: url("/Excalifont-Regular.woff2");
  font-weight: normal;
  font-style: normal;
}
</style>
