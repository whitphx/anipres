import {
  createTLStore,
  defaultAddFontsFromNode,
  Editor,
  tipTapDefaultExtensions,
} from "tldraw";
import type {
  TLStoreSnapshot,
  TLEditorSnapshot,
  TLPageId,
  TLPage,
  TLShape,
  TLStateNodeConstructor,
  TLTextOptions,
} from "tldraw";

import { deriveTimelineFromShapes } from "./legacy-models";

import { allShapeUtils, allBindingUtils } from "./shape-utils";

const defaultTextOptions: TLTextOptions = {
  tipTapConfig: { extensions: tipTapDefaultExtensions },
  addFontsFromNode: defaultAddFontsFromNode,
};

interface LoadHeadlessEditorOptions {
  snapshot?: Partial<TLEditorSnapshot> | TLStoreSnapshot;
  pageId?: TLPageId;
}
export function loadHeadlessEditor(
  opts: LoadHeadlessEditorOptions = {},
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
    // Required so shapes with rich-text labels (e.g. geo) can be created
    // headlessly — the GeoShapeUtil's `onBeforeCreate` measures text size,
    // which calls into the tipTap renderer.
    textOptions: defaultTextOptions,
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
  const storeSnapshot =
    "document" in snapshot && snapshot.document
      ? snapshot.document
      : "store" in snapshot && snapshot.store
        ? (snapshot as TLStoreSnapshot)
        : undefined;
  if (!storeSnapshot) return 0;
  const records = Object.values(storeSnapshot.store);
  const pages = records.filter(
    (record): record is TLPage => record.typeName === "page",
  );
  const sessionPageId =
    "session" in snapshot ? snapshot.session?.currentPageId : undefined;
  const pageId =
    pages.find((page) => page.id === sessionPageId)?.id ?? pages[0]?.id;
  if (!pageId) return 0;

  const allShapes = records.filter(
    (record): record is TLShape => record.typeName === "shape",
  );
  const shapeById = new Map(allShapes.map((shape) => [shape.id, shape]));
  const pageShapes = allShapes.filter((shape) => {
    let parentId = shape.parentId;
    const visited = new Set<string>();
    while (shapeById.has(parentId as never)) {
      if (visited.has(parentId)) return false;
      visited.add(parentId);
      parentId = shapeById.get(parentId as never)!.parentId;
    }
    return parentId === pageId;
  });
  return deriveTimelineFromShapes(pageShapes, pageId).steps.length;
}
