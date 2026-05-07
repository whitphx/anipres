// `installDomGlobals()` patches a happy-dom-backed `window`,
// `document`, and friends onto `globalThis` so tldraw's headless
// `Editor` can construct under Node — its constructor and various
// runtime paths reach for `document.createElement`, `HTMLElement`,
// etc. (verified by `loadHeadlessEditor()` throwing "document is
// not defined" without these).
//
// Tldraw and anipres themselves import cleanly under plain Node
// (verified empirically). The DOM access is gated to constructor
// time, not module-load time, which is why a function-call API
// works here — callers just need to invoke `installDomGlobals()`
// before instantiating an `Editor` (i.e. before
// `loadHeadlessEditor()`). The function is idempotent, so the
// pattern is to call it at the top of any public entry point
// (e.g. `editSnapshot`, `summarizeSnapshot`).
//
// `disposeDomGlobals()` is the matching teardown. happy-dom's
// `Window` keeps internal Timeouts / MessagePorts / Immediates
// alive that the Node event loop won't drain on its own, so a
// CLI invocation that completes its work successfully would still
// hang waiting for those handles. Per happy-dom's docs, calling
// `Window.close()` releases them. Public entry points should
// dispose in a `finally` so single-shot processes (the CLI) exit
// cleanly; long-lived hosts (the MCP server) just pay the cost
// of recreating the Window on each request, which is cheap.
//
// We intentionally don't use vitest's `// @vitest-environment
// happy-dom` magic comment for this surface — those tests run in
// vitest, but the CLI / MCP entry points run in plain Node, so the
// runtime install is the load-bearing one.

import { Window } from "happy-dom";

let win: Window | null = null;

export function installDomGlobals(): void {
  if (win) return;
  win = new Window({ url: "http://localhost/" });
  const g = globalThis as unknown as Record<string, unknown>;

  // Force the DOM-shaped globals tldraw actually uses.
  setForce(g, "window", win);
  setForce(g, "document", win.document);
  setForce(g, "HTMLElement", win.HTMLElement);
  setForce(g, "Element", win.Element);
  setForce(g, "Node", win.Node);
  setForce(g, "DocumentFragment", win.DocumentFragment);

  // `navigator` is read-only on Node ≥ 22 — only set it if missing.
  setIfAbsent(g, "navigator", win.navigator);

  setIfAbsent(
    g,
    "requestAnimationFrame",
    (cb: (t: number) => void) =>
      setTimeout(() => cb(Date.now()), 16) as unknown as number,
  );
  setIfAbsent(g, "cancelAnimationFrame", (id: number) =>
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  );
}

export function disposeDomGlobals(): void {
  if (!win) return;
  void win.close();
  win = null;
}

function setIfAbsent(
  g: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
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

function setForce(
  g: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
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
