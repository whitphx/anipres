import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { apiClient } from "../lib/api-client";
import { AuthContext } from "./useAuth";

const ME_KEY = ["auth", "me"] as const;

// `/auth/me` returns 401 with a JSON error body when not logged in
// — that's "logged out", not a fetch error — so the fetcher maps 401
// to `null` instead of throwing. Other non-2xx statuses (a 500 from
// an uncaught server exception, say) DO throw, so SWR's `error`
// channel surfaces real failures rather than silently logging the
// user out. The typed contract is 200|401; the `as Response` cast on
// the throw branch is the price of TS narrowing `res` to `never`
// after we've exhausted the typed status union — at runtime
// `res.status` is still the real number.
export async function fetchMe() {
  const res = await apiClient.auth.me.$get();
  if (res.status === 200) return res.json();
  if (res.status === 401) return null;
  throw new Error(`Request failed (${(res as Response).status})`);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // SWR handles cancellation, dedup, and focus revalidation. The
  // focus-revalidation behavior covers a real case here: a user who
  // logs out in another tab gets reflected in this tab on focus
  // without needing a cross-tab broadcast.
  const { data, isLoading: loading } = useSWR(ME_KEY, fetchMe);
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
    const res = await apiClient.auth.logout.$post();
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
