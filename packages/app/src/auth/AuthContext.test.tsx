import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig, type ScopedMutator } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./AuthContext";
import { fetchMe } from "./me-fetcher";
import { useAuth } from "./useAuth";

vi.mock("./me-fetcher", () => ({
  fetchMe: vi.fn(),
}));

const fetchMeMock = vi.mocked(fetchMe);

function Probe({
  mutateRef,
}: {
  mutateRef: { current: ScopedMutator | null };
}) {
  const { user, loading } = useAuth();
  const { mutate } = useSWRConfig();
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate, mutateRef]);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user ? String(user.id) : "null"}</span>
    </div>
  );
}

function renderProvider() {
  const mutateRef: { current: ScopedMutator | null } = { current: null };
  render(
    // A fresh cache per test; retries are triggered manually via
    // `mutate` so the test doesn't depend on SWR's backoff timing.
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      <AuthProvider>
        <Probe mutateRef={mutateRef} />
      </AuthProvider>
    </SWRConfig>,
  );
  return {
    triggerRevalidation: () => mutateRef.current!(["auth", "me"]),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthProvider loading semantics", () => {
  it("stops reporting loading once the first attempt fails, even while a retry is in flight", async () => {
    fetchMeMock.mockRejectedValueOnce(new Error("Request failed (500)"));
    const { triggerRevalidation } = renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false"),
    );
    expect(screen.getByTestId("user").textContent).toBe("null");

    // A retry request in flight (no data yet, error recorded) must not
    // flip `loading` back to true — that unmounts the whole app on
    // every retry when the server is down.
    let resolveRetry!: (value: null) => void;
    fetchMeMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRetry = resolve)),
    );
    let revalidation!: Promise<unknown>;
    act(() => {
      revalidation = triggerRevalidation();
    });
    expect(screen.getByTestId("loading").textContent).toBe("false");

    await act(async () => {
      resolveRetry(null);
      await revalidation.catch(() => {});
    });
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("reports loading during the very first attempt and exposes the user on success", async () => {
    let resolveFirst!: (value: { id: number }) => void;
    fetchMeMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    renderProvider();

    expect(screen.getByTestId("loading").textContent).toBe("true");

    await act(async () => {
      resolveFirst({ id: 42 });
    });
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false"),
    );
    expect(screen.getByTestId("user").textContent).toBe("42");
  });
});
