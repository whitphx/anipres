import { useCallback } from "react";
import useSWR from "swr";
import type { User } from "./types";
import { AuthContext } from "./useAuth";

const ME_KEY = "/auth/me";

// `/auth/me` returns 401 with a JSON error body when not logged in
// — that's "logged out", not a fetch error — so the fetcher maps 401
// to `null` instead of throwing. Other non-ok statuses still throw so
// SWR's `error` channel surfaces real failures.
async function fetchMe(url: string): Promise<User | null> {
  const res = await fetch(url);
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as User;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // SWR handles cancellation, dedup, and focus revalidation. The
  // focus-revalidation behavior covers a real case here: a user who
  // logs out in another tab gets reflected in this tab on focus
  // without needing a cross-tab broadcast.
  const {
    data,
    isLoading: loading,
    mutate,
  } = useSWR<User | null>(ME_KEY, fetchMe);
  const user = data ?? null;

  const loginWithGitHub = useCallback(() => {
    window.location.href = "/auth/github";
  }, []);

  const loginWithGoogle = useCallback(() => {
    window.location.href = "/auth/google";
  }, []);

  const logout = useCallback(async () => {
    const res = await fetch("/auth/logout", { method: "POST" });
    if (res.ok) {
      // Update the SWR cache to "logged out" without an extra
      // round-trip. revalidate:false skips the follow-up GET that
      // would otherwise fire — it'd return 401 anyway, so the GET
      // is pure overhead.
      await mutate(null, { revalidate: false });
    }
  }, [mutate]);

  return (
    <AuthContext.Provider
      value={{ user, loading, loginWithGitHub, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
