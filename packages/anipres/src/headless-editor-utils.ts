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

/**
 * Deterministic page selection — never `Object.values` iteration order:
 * 1. An explicit `pageId` argument wins.
 * 2. A `TLEditorSnapshot`'s `session.currentPageId`, when it references
 *    an existing page record.
 * 3. Otherwise the page with the smallest tldraw page index (code-unit
 *    comparison; ties broken by id).
 * 4. No page records → null (zero steps).
 */
function resolvePageId(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
  explicitPageId?: string,
): string | null {
  const storeSnapshot: TLStoreSnapshot | undefined =
    "store" in snapshot && snapshot.store != null
      ? (snapshot as TLStoreSnapshot)
      : (snapshot as Partial<TLEditorSnapshot>).document;
  const pages = (Object.values(storeSnapshot?.store ?? {}) as unknown[]).filter(
    (record): record is { id: string; index: string } =>
      (record as { typeName?: string }).typeName === "page",
  );
  if (explicitPageId != null) {
    return explicitPageId;
  }
  if (pages.length === 0) {
    return null;
  }
  const sessionPageId =
    "store" in snapshot
      ? undefined
      : (snapshot as Partial<TLEditorSnapshot>).session?.currentPageId;
  if (
    sessionPageId != null &&
    pages.some((page) => page.id === sessionPageId)
  ) {
    return sessionPageId;
  }
  return [...pages].sort((a, b) =>
    a.index !== b.index
      ? a.index < b.index
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  )[0].id;
}

export function calculateTotalSteps(
  snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot,
  options: { pageId?: string } = {},
): number {
  // Read the snapshot's shape records directly — no headless Editor
  // needed. The derivation is mixed-tolerant: v1 frames are converted in
  // memory with the same deterministic mapping migration uses.
  //
  // Scope to the resolved page (transitively through shape parents) so a
  // multi-page snapshot never mixes pages into one count.
  const pageId = resolvePageId(snapshot, options.pageId);
  if (pageId == null) {
    return 0;
  }
  const allShapes = getShapeRecordsFromSnapshot(snapshot);
  const onPage = new Set<string>([pageId]);
  for (let added = true; added; ) {
    added = false;
    for (const shape of allShapes) {
      if (!onPage.has(shape.id) && onPage.has(shape.parentId)) {
        onPage.add(shape.id);
        added = true;
      }
    }
  }
  const shapes = allShapes.filter((shape) => onPage.has(shape.id));
  const doc = deriveTimeline({
    shapes: shapes.map((shape) => ({
      shapeId: shape.id,
      frameMeta: shape.meta?.frame,
    })),
    pageId,
  });
  return doc.steps.length;
}
