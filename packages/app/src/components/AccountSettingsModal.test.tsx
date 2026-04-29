import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { AccountSettingsModal } from "./AccountSettingsModal";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

// Wrap each render in a fresh SWR cache + zero dedup window so tests
// don't leak fetch results across each other (SWR's default cache is
// module-global and the default 2s dedup interval would hide the
// per-test `mockResolvedValueOnce` setups).
function renderModal(ui: ReactNode) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
      }}
    >
      {ui}
    </SWRConfig>,
  );
}

describe("AccountSettingsModal", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders linked identities returned by /auth/identities", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        {
          provider: "github",
          provider_id: "gh-123",
          created_at: 1_700_000_000_000,
        },
      ]),
    );

    renderModal(<AccountSettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeTruthy();
    });
    // Connect-Google button is offered (the only unlinked provider).
    expect(
      screen.getByRole("button", { name: /connect google/i }),
    ).toBeTruthy();
    // Connect-GitHub is NOT offered (already linked).
    expect(
      screen.queryByRole("button", { name: /connect github/i }),
    ).toBeNull();
  });

  it("shows the all-linked note when both providers are linked", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        { provider: "github", provider_id: "gh-1", created_at: 1 },
        { provider: "google", provider_id: "go-1", created_at: 2 },
      ]),
    );

    renderModal(<AccountSettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/all supported providers are already linked/i),
      ).toBeTruthy();
    });
  });

  it("renders the success flash when an account-link redirect lands here", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    renderModal(
      <AccountSettingsModal
        onClose={() => {}}
        initialFlash={{ code: "success", kind: "success" }}
      />,
    );

    expect(screen.getByRole("status").textContent).toMatch(/connected/i);
  });

  it("renders the conflict flash with role=alert when identity is in use", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    renderModal(
      <AccountSettingsModal
        onClose={() => {}}
        initialFlash={{ code: "identity_in_use", kind: "error" }}
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(
      /already linked to a different/i,
    );
  });

  it("calls onClose when Escape is pressed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));
    const onClose = vi.fn();

    renderModal(<AccountSettingsModal onClose={onClose} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a load error when /auth/identities returns non-ok", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(null, 401));

    renderModal(<AccountSettingsModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/could not load/i)).toBeTruthy();
    });
  });

  describe("unlink", () => {
    it("hides the unlink button and shows a note when only one identity is linked", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          { provider: "github", provider_id: "gh-1", created_at: 1 },
        ]),
      );

      renderModal(<AccountSettingsModal onClose={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText("GitHub")).toBeTruthy();
      });
      expect(
        screen.queryByRole("button", { name: /unlink github/i }),
      ).toBeNull();
      expect(
        screen.getByText(/link another provider before unlinking/i),
      ).toBeTruthy();
    });

    it("offers an unlink button per identity when multiple are linked", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          { provider: "github", provider_id: "gh-1", created_at: 1 },
          { provider: "google", provider_id: "go-1", created_at: 2 },
        ]),
      );

      renderModal(<AccountSettingsModal onClose={() => {}} />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /unlink github/i }),
        ).toBeTruthy();
      });
      expect(
        screen.getByRole("button", { name: /unlink google/i }),
      ).toBeTruthy();
    });

    it("requires a confirm step before sending the DELETE", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse([
          { provider: "github", provider_id: "gh-1", created_at: 1 },
          { provider: "google", provider_id: "go-1", created_at: 2 },
        ]),
      );

      renderModal(<AccountSettingsModal onClose={() => {}} />);

      const unlinkBtn = await screen.findByRole("button", {
        name: /unlink github/i,
      });

      // First click: row enters confirm state, no DELETE yet.
      act(() => {
        unlinkBtn.click();
      });

      expect(screen.getByRole("button", { name: /^confirm$/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /^cancel$/i })).toBeTruthy();
      // Only the original GET — no DELETE yet.
      expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    });

    it("DELETEs the identity and refreshes the list when Confirm is clicked", async () => {
      // Initial GET with two identities, then DELETE, then refresh GET
      // with one identity.
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse([
            { provider: "github", provider_id: "gh-1", created_at: 1 },
            { provider: "google", provider_id: "go-1", created_at: 2 },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse({ ok: true }))
        .mockResolvedValueOnce(
          jsonResponse([
            { provider: "google", provider_id: "go-1", created_at: 2 },
          ]),
        );

      renderModal(<AccountSettingsModal onClose={() => {}} />);

      const unlinkBtn = await screen.findByRole("button", {
        name: /unlink github/i,
      });
      act(() => {
        unlinkBtn.click();
      });
      const confirmBtn = await screen.findByRole("button", {
        name: /^confirm$/i,
      });
      await act(async () => {
        confirmBtn.click();
      });

      await waitFor(() => {
        // After the DELETE + revalidate, GitHub is gone; Google remains.
        expect(screen.queryByText("GitHub")).toBeNull();
        expect(screen.getByText("Google")).toBeTruthy();
      });

      // Inspect the wire: second call should be a DELETE.
      const deleteCall = vi.mocked(fetch).mock.calls[1];
      expect(deleteCall[0]).toBe("/auth/identities/github/gh-1");
      expect(deleteCall[1]?.method).toBe("DELETE");
    });

    it("surfaces the last-identity error on a 409 response", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          jsonResponse([
            { provider: "github", provider_id: "gh-1", created_at: 1 },
            { provider: "google", provider_id: "go-1", created_at: 2 },
          ]),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              error: "Cannot remove your last sign-in method.",
              code: "last_identity",
            },
            409,
          ),
        );

      renderModal(<AccountSettingsModal onClose={() => {}} />);

      const unlinkBtn = await screen.findByRole("button", {
        name: /unlink github/i,
      });
      act(() => {
        unlinkBtn.click();
      });
      const confirmBtn = await screen.findByRole("button", {
        name: /^confirm$/i,
      });
      await act(async () => {
        confirmBtn.click();
      });

      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toMatch(
          /only sign-in method/i,
        );
      });
    });
  });
});
