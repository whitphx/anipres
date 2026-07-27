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
  TLShape,
  TLStateNodeConstructor,
  TLTextOptions,
} from "tldraw";

import { deriveTimeline } from "./timeline-model";

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

/**
 * Extracts the shape records embedded in a snapshot without instantiating
 * an Editor. `meta.frame` is plain JSON inside the store records, so step
 * counting does not need tldraw's runtime at all.
 */
export function getShapeRecordsFromSnapshot(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
): TLShape[] {
  const storeSnapshot: TLStoreSnapshot | undefined =
    "store" in snapshot && snapshot.store != null
      ? (snapshot as TLStoreSnapshot)
      : (snapshot as Partial<TLEditorSnapshot>).document;
  if (storeSnapshot?.store == null) {
    return [];
  }
  return Object.values(storeSnapshot.store).filter(
    (record): record is TLShape =>
      (record as { typeName?: string }).typeName === "shape",
  );
}

function getPageIdFromSnapshot(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
): string {
  const storeSnapshot: TLStoreSnapshot | undefined =
    "store" in snapshot && snapshot.store != null
      ? (snapshot as TLStoreSnapshot)
      : (snapshot as Partial<TLEditorSnapshot>).document;
  const page = Object.values(storeSnapshot?.store ?? {}).find(
    (record) => (record as { typeName?: string }).typeName === "page",
  );
  return (page as { id?: string } | undefined)?.id ?? "page:page";
}

export function calculateTotalSteps(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
): number {
  // Read the snapshot's shape records directly — no headless Editor
  // needed. The derivation is mixed-tolerant: v1 frames are converted in
  // memory with the same deterministic mapping migration uses.
  const shapes = getShapeRecordsFromSnapshot(snapshot);
  const doc = deriveTimeline({
    shapes: shapes.map((shape) => ({
      shapeId: shape.id,
      frameMeta: shape.meta?.frame,
    })),
    pageId: getPageIdFromSnapshot(snapshot),
  });
  return doc.steps.length;
}
