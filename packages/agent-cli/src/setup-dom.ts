// Tldraw's headless `Editor` constructor still touches `document` to register
// its container element. Install happy-dom globals before any tldraw import
// so this works under Node.

import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });

const g = globalThis as unknown as Record<string, unknown>;

function setIfAbsent(key: string, value: unknown): void {
  if (g[key] !== undefined) return;
  try {
    g[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

function setForce(key: string, value: unknown): void {
  try {
    g[key] = value;
  } catch {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

// Force the DOM-shaped globals tldraw actually uses.
setForce("window", win);
setForce("document", win.document);
setForce("HTMLElement", win.HTMLElement);
setForce("Element", win.Element);
setForce("Node", win.Node);
setForce("DocumentFragment", win.DocumentFragment);

// `navigator` is read-only on Node ≥ 22 — only set it if missing.
setIfAbsent("navigator", win.navigator);

setIfAbsent(
  "requestAnimationFrame",
  (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number,
);
setIfAbsent("cancelAnimationFrame", (id: number) =>
  clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
);
