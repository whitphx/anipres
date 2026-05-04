import { createTLStore, Editor } from "tldraw";
import type {
  TLStoreSnapshot,
  TLEditorSnapshot,
  TLPageId,
  TLStateNodeConstructor,
} from "tldraw";

import { getFrames, getFrameBatches } from "./models";
import { getGlobalOrder } from "./ordered-track-item";

import { allShapeUtils, allBindingUtils } from "./shape-utils";

interface LoadHeadlessEditorOptions {
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot;
  pageId?: TLPageId;
}
function loadHeadlessEditor(
  opts: LoadHeadlessEditorOptions,
): [Editor, () => void] {
  // Ref: https://github.com/tldraw/tldraw/blob/5edd5d63f975522c2d200c3d5d1756042fd585fb/packages/tldraw/src/lib/TldrawImage.tsx

  const { snapshot, pageId } = opts;

  const tools: TLStateNodeConstructor[] = []; // We don't need to register tools here because this editor is not intended to have a UI

  const store = createTLStore({
    snapshot,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
  });

  const container = document.createElement("div");
  container.classList.add("tl-container", "tl-theme__light");

  const tempElm = document.createElement("div");
  container.appendChild(tempElm);

  const editor = new Editor({
    store,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
    tools,
    getContainer: () => tempElm,
  });

  if (pageId) editor.setCurrentPage(pageId);

  const dispose = () => {
    editor.dispose();
    container.remove();
  };

  return [editor, dispose];
}

export function calculateTotalSteps(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
): number {
  const [editor, dispose] = loadHeadlessEditor({ snapshot });

  const shapes = editor.getCurrentPageShapes();
  const allFrames = getFrames(shapes);
  const frameBatches = getFrameBatches(allFrames);
  const orderedSteps = getGlobalOrder(frameBatches);
  const totalSteps = orderedSteps.length;

  dispose();

  return totalSteps;
}
