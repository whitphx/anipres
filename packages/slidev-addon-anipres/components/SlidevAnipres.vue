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
// @ts-expect-error virtual import
import * as xiaolai from "/@xiaolai-font";
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

const fontFamily = computed(() => {
  if (props.excalidrawLikeFont) {
    return `Excalifont-Regular, "${xiaolai.css.family}", ${xiaolai.fontFamilyFallback}, 'tldraw_draw'`;
  }
  return `'tldraw_draw'`;
});
</script>

<template>
  <div
    :class="['container', 'inverse-transform', { editing: isEditing }]"
    ref="container"
    @dblclick="onDblclick"
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

.container :deep(.tl-theme__light, .tl-theme__dark) {
  --color-background: rgba(0, 0, 0, 0);
}

.container:not(.editing) :deep(.tl-container__focused) {
  outline: none;
}

:deep(.tl-container) {
  --tl-font-draw: v-bind(fontFamily);
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
