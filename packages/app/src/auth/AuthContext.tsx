import { useCallback, useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import { apiClient } from "../lib/api-client";
import { broadcastLogout, subscribeToAuthBroadcasts } from "./auth-broadcast";
import { fetchMe } from "./me-fetcher";
import { AuthContext } from "./useAuth";

const ME_KEY = ["auth", "me"] as const;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // SWR handles cancellation, dedup, and focus revalidation. The
  // focus-revalidation behavior covers a real case here: a user who
  // logs out in another tab gets reflected in this tab on focus
  // without needing a cross-tab broadcast. The BroadcastChannel
  // listener wired up below makes that propagation immediate so
  // tabs don't sit on stale auth state until the user clicks them.
  const { data, isLoading: loading } = useSWR(ME_KEY, fetchMe);
  const user = data ?? null;

  // Pull the global mutate so logout can wipe every SWR cache key,
  // not just `/auth/me`. The server-side cookie clearing already
  // protects the API surface (every authenticated route returns 401
  // post-logout), but stale auth-scoped cache values would otherwise
  // linger in any open UI surface that read them — see the comment
  // on logout below.
  const { mutate: globalMutate } = useSWRConfig();

  const wipeAllCaches = useCallback(async () => {
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
  }, [globalMutate]);

  useEffect(() => {
    return subscribeToAuthBroadcasts((message) => {
      if (message.type === "logout") {
        void wipeAllCaches();
      }
    });
  }, [wipeAllCaches]);

  const loginWithGitHub = useCallback(() => {
    window.location.href = "/auth/github";
  }, []);

  const loginWithGoogle = useCallback(() => {
    window.location.href = "/auth/google";
  }, []);

  const logout = useCallback(async () => {
    const res = await apiClient.auth.logout.$post();
    if (res.ok) {
      await wipeAllCaches();
      broadcastLogout();
    }
  }, [wipeAllCaches]);

  return (
    <AuthContext.Provider
      value={{ user, loading, loginWithGitHub, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}
