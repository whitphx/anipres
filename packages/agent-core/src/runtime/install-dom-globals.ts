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
// `loadHeadlessEditor()`). The function is idempotent.
//
// We don't expose a corresponding `disposeDomGlobals()`. happy-dom's
// `Window.close()` is async and only partially drains its internal
// handles even when awaited, and `import "anipres"` itself installs
// process-level handles (timers from tldraw's transitive deps) that
// no DOM-side teardown can reach. Single-shot CLIs need to call
// `process.exit(0)` at the end of their flow to exit cleanly;
// long-lived hosts (MCP server) just leave the install in place
// across requests.
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
