import { useEffect, useMemo } from "react";
import useSWR from "swr";
import * as xiaolai from "./fonts/XiaolaiSC-Regular.ttf";
import "anipres/anipres.css";
import { IdbDocumentRepository } from "./documents/idb-repository";
import { ApiDocumentRepository } from "./documents/api-repository";
import { DocumentManagerProvider } from "./documents/DocumentManagerContext";
import { SyncedRepositoryProvider } from "./documents/SyncedRepositoryContext";
import { AppContent } from "./AppContent";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";
import { apiClient } from "./lib/api-client";

function AuthenticatedApp() {
  const { user, loading: authLoading } = useAuth();
  const localRepository = useMemo(() => new IdbDocumentRepository(), []);

  // Server-side documents are workspace-owned. After login we discover
  // the user's workspaces via `GET /api/workspaces` and bind the synced
  // repo to the (Phase 1: only) workspace returned. Extension A will
  // surface the list to the user; for now we just take the first row.
  //
  // Conditional key: SWR doesn't fetch when key is null. Logged-out
  // users skip the fetch entirely; the moment a user lands the key
  // flips to the (workspaces) tuple and SWR fires the request via the
  // typed RPC client below.
  const { data: workspaces, error: workspaceFetchError } = useSWR(
    user ? (["api", "workspaces"] as const) : null,
    async () => {
      const res = await apiClient.api.workspaces.$get();
      if (res.status !== 200) {
        throw new Error(`Request failed (${res.status})`);
      }
      return res.json();
    },
  );

  // Derived state. The `user &&` guards make logout robust against
  // SWR's per-key cache potentially still holding the previous user's
  // workspace data — derived values become null the moment user is
  // null, regardless of cache state.
  const workspaceId =
    user && workspaces && workspaces.length > 0 ? workspaces[0].id : null;
  const workspaceError = user
    ? ((workspaceFetchError instanceof Error
        ? workspaceFetchError.message
        : null) ??
      (workspaces && workspaces.length === 0
        ? "no workspace found for this account"
        : null))
    : null;

  // Log workspace errors when they appear. The console message helps
  // diagnose the rare path where Phase 1's workspace-on-signup
  // invariant is violated or the server is unreachable.
  useEffect(() => {
    if (workspaceError) {
      console.error(
        `Workspace discovery failed: ${workspaceError}. The app cannot reach the server-backed document store.`,
      );
    }
  }, [workspaceError]);

  const syncedRepository = useMemo(
    () =>
      user !== null && workspaceId !== null
        ? new ApiDocumentRepository(workspaceId)
        : undefined,
    [user, workspaceId],
  );

  if (authLoading) {
    return null;
  }

  // Logged in but workspace discovery failed — Phase 1 invariant says
  // login always provisions exactly one workspace, so this path is
  // genuinely broken state (server unreachable, account in a bad
  // shape, etc.). Surface a message instead of hanging on a blank
  // screen.
  if (user !== null && workspaceError !== null) {
    return (
      <div role="alert" style={{ padding: "1rem", textAlign: "center" }}>
        <p>Could not load your workspace: {workspaceError}.</p>
        <p>Please try refreshing the page.</p>
      </div>
    );
  }

  // Wait for both auth resolution and (when logged in) workspace
  // discovery before rendering. Without this, a logged-in user would
  // briefly see the local-only experience while the workspace fetch
  // is in flight.
  if (user !== null && workspaceId === null) {
    return null;
  }

  return (
    <>
      <style>{`
        @font-face {
          font-family: 'Excalifont-Regular';
          src: url('/Excalifont-Regular.woff2');
          font-weight: normal;
          font-style: normal;
        }

        .tl-container {
          --tl-font-draw: Excalifont-Regular, '${xiaolai.css.family}', ${xiaolai.fontFamilyFallback}, 'tldraw_draw';
        }
      `}</style>
      <SyncedRepositoryProvider repository={syncedRepository ?? null}>
        <DocumentManagerProvider
          localRepository={localRepository}
          syncedRepository={syncedRepository}
          workspaceId={workspaceId}
        >
          <AppContent />
        </DocumentManagerProvider>
      </SyncedRepositoryProvider>
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

export default App;
