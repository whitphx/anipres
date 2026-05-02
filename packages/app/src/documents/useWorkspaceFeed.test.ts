import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceFeed } from "./useWorkspaceFeed";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  emit(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  close() {
    this.closed = true;
  }
}

let originalEventSource: typeof EventSource;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  originalEventSource = globalThis.EventSource;
  // @ts-expect-error — minimal stub for the API surface the hook uses
  globalThis.EventSource = FakeEventSource;
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  vi.useRealTimers();
});

describe("useWorkspaceFeed", () => {
  it("opens EventSource on the workspace events URL and forwards messages", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkspaceFeed("42", onChange));

    expect(FakeEventSource.instances).toHaveLength(1);
    // The URL also carries the per-tab client id as a query param —
    // tested separately below; here we just match the path portion.
    expect(FakeEventSource.instances[0].url).toMatch(
      /^\/api\/workspaces\/42\/events\?/u,
    );

    FakeEventSource.instances[0].emit('{"type":"documents:changed"}');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("includes the client id in the EventSource query string", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkspaceFeed("42", onChange));

    const url = new URL(FakeEventSource.instances[0].url, "http://example.com");
    expect(url.searchParams.get("client_id")).toMatch(/^[0-9a-f-]+$/u);
  });

  it("polls the onChange callback as a backstop", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkspaceFeed("42", onChange));

    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("calls onChange on window focus", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkspaceFeed("42", onChange));

    window.dispatchEvent(new Event("focus"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe when workspaceId is null", () => {
    const onChange = vi.fn();
    renderHook(() => useWorkspaceFeed(null, onChange));

    expect(FakeEventSource.instances).toHaveLength(0);
    vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event("focus"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes EventSource and stops polling on unmount", () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useWorkspaceFeed("42", onChange));

    const es = FakeEventSource.instances[0];
    unmount();

    expect(es.closed).toBe(true);
    vi.advanceTimersByTime(30_000);
    window.dispatchEvent(new Event("focus"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the latest onChange reference without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useWorkspaceFeed("42", cb), {
      initialProps: { cb: first },
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    rerender({ cb: second });
    // No new connection — same instance, same close state.
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0].emit('{"type":"documents:changed"}');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("tears down the old EventSource and opens a new one when workspaceId changes", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useWorkspaceFeed(id, onChange),
      { initialProps: { id: "1" as string | null } },
    );

    const first = FakeEventSource.instances[0];
    expect(first.url).toMatch(/^\/api\/workspaces\/1\/events\?/u);
    expect(first.closed).toBe(false);

    rerender({ id: "2" });

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toMatch(
      /^\/api\/workspaces\/2\/events\?/u,
    );
  });
});
