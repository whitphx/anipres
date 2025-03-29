<script lang="ts">
import { createRoot } from "react-dom/client";
import { setVeauryOptions, applyPureReactInVue } from "veaury";
import {
  Anipres as AnipresReact,
  type AnipresRef as AnipresReactRef,
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
} from "tldraw";
import { ref, useTemplateRef, watch, computed } from "vue";
import { useCssVar, useStyleTag, onClickOutside } from "@vueuse/core";
import {
  onSlideEnter,
  onSlideLeave,
  useDarkMode,
  useSlideContext,
} from "@slidev/client";
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
    editable?: boolean;
    start?: number;
    fontUrls?: Partial<TLEditorAssetUrls["fonts"]>;
    fontUrl?: string; // Short hand for fontUrls.draw
    excalidrawLikeFont?: boolean;
  }>(),
  {
    editable: true,
    start: 0,
    fontUrls: () => ({}),
    fontUrl: undefined,
    excalidrawLikeFont: false,
  },
);

const fontUrls = computed(() => ({
  ...props.fontUrls,
  draw: props.fontUrls.draw ?? props.fontUrl,
}));

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

const { $scale, $clicks } = useSlideContext();

const container = ref<HTMLElement>();

const isEditing = ref(false);

const savedSnapshot: SavedSnapshot | undefined = ALL_SNAPSHOT[props.id];

function onDblclick() {
  if (props.editable && import.meta.hot) isEditing.value = !isEditing.value;
}

onClickOutside(container, () => {
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

const handleMount = (editor: Editor) => {
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
  editor.store.listen(debouncedSave, { source: "user", scope: "document" });

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
  const container = editor.getContainer();
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
  observer.observe(container);

  document.fonts.addEventListener("loadingdone", resetTextAutoSize);

  return () => {
    observer.disconnect();
    document.fonts.removeEventListener("loadingdone", resetTextAutoSize);
  };
};

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

const drawStyleFontFamily = computed(() => {
  if (props.excalidrawLikeFont) {
    return `Excalifont-Regular, "${xiaolaiFont.css.family}", ${xiaolaiFont.fontFamilyFallback}, 'tldraw_draw'`;
  }
  return `'tldraw_draw'`;
});

// Prevent these keydown events from being propagated
// for keyboard shortcuts to move the shapes in edit mode.
// In contrast, other keydown events such as `Backspace` or `Ctrl-z`
// should be propagated so that the keyboard shortcuts work.
const KEYS_NOT_TO_BE_PROPAGATED = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
];
function onKeyDown(e: KeyboardEvent) {
  if (isEditing.value) {
    if (KEYS_NOT_TO_BE_PROPAGATED.includes(e.key)) {
      e.stopPropagation();
    }
  }
}
</script>

<template>
  <div
    :class="['container', 'inverse-transform', { editing: isEditing }]"
    ref="container"
    @dblclick="onDblclick"
    @keydown="onKeyDown"
  >
    <Anipres
      v-if="isMountedOnce"
      ref="anipres"
      @mount="handleMount"
      :step="$clicks"
      @stepChange="$clicks = $event"
      :presentationMode="!isEditing"
      :snapshot="savedSnapshot"
      :startStep="props.start"
      :assetUrls="{ fonts: fontUrls }"
    />
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
.inverse-transform {
  width: calc(var(--slide-scale) * 100%);
  height: calc(var(--slide-scale) * 100%);
  transform: scale(calc(1 / var(--slide-scale)));
  transform-origin: top left;
}

.container :deep(p) {
  /* Disable Slidev's styles in Anipres */
  margin-top: inherit;
  margin-bottom: inherit;
  line-height: inherit;
}

.container :deep(.tl-theme__light, .tl-theme__dark) {
  --color-background: rgba(0, 0, 0, 0);
}

.container:not(.editing) :deep(.tl-container__focused) {
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
