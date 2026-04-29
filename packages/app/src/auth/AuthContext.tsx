import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
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
  const { data, isLoading: loading } = useSWR<User | null>(ME_KEY, fetchMe);
  const user = data ?? null;

  // Pull the global mutate so logout can wipe every SWR cache key,
  // not just `/auth/me`. The server-side cookie clearing already
  // protects the API surface (every authenticated route returns 401
  // post-logout), but stale auth-scoped cache values would otherwise
  // linger in any open UI surface that read them — see the comment
  // on logout below.
  const { mutate: globalMutate } = useSWRConfig();

  const loginWithGitHub = useCallback(() => {
    window.location.href = "/auth/github";
  }, []);

  const loginWithGoogle = useCallback(() => {
    window.location.href = "/auth/google";
  }, []);

  const logout = useCallback(async () => {
    const res = await fetch("/auth/logout", { method: "POST" });
    if (res.ok) {
      // Wipe every SWR cache key, not just `/auth/me`. After logout,
      // any data fetched while authenticated (workspaces, identities,
      // future endpoints) belongs to the previous session; the server
      // would now return 401, so any subsequent UI that reads the
      // cache is showing stale prior-session data. `revalidate:false`
      // skips a flurry of immediate refetches that would all 401
      // anyway. Background revalidation on the next focus event will
      // refresh whatever the new logged-out state needs.
      //
      // `() => true` is the SWR-canonical match-all-keys filter.
      await globalMutate(() => true, undefined, { revalidate: false });
    }
  }, [globalMutate]);

  return (
    <AuthContext.Provider
      value={{ user, loading, loginWithGitHub, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
