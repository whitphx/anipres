import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NetworkStatus } from "./NetworkStatus";

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
  });
}

function fireNetworkEvent(type: "online" | "offline") {
  window.dispatchEvent(new Event(type));
}

describe("NetworkStatus", () => {
  afterEach(() => {
    // Unmount prior render so subsequent `screen` / role queries don't
    // see stale DOM nodes. testing-library does not auto-cleanup under
    // vitest without a setup file.
    cleanup();
    // Reset to the default "online" state so tests don't leak navigator
    // state across each other.
    setNavigatorOnline(true);
    vi.restoreAllMocks();
  });

  it("renders nothing when navigator reports online", () => {
    setNavigatorOnline(true);
    const { container } = render(<NetworkStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an Offline pill when navigator reports offline on mount", () => {
    setNavigatorOnline(false);
    render(<NetworkStatus />);
    expect(screen.getByRole("status").textContent).toContain("Offline");
  });

  it("shows the pill when an offline event fires after mount", () => {
    setNavigatorOnline(true);
    const { queryByRole } = render(<NetworkStatus />);
    expect(queryByRole("status")).toBeNull();

    act(() => {
      setNavigatorOnline(false);
      fireNetworkEvent("offline");
    });

    expect(screen.getByRole("status").textContent).toContain("Offline");
  });

  it("hides the pill when an online event fires after going offline", () => {
    setNavigatorOnline(false);
    const { queryByRole } = render(<NetworkStatus />);
    expect(queryByRole("status")?.textContent).toContain("Offline");

    act(() => {
      setNavigatorOnline(true);
      fireNetworkEvent("online");
    });

    expect(queryByRole("status")).toBeNull();
  });
});
