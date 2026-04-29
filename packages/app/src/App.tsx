import { useEffect, useMemo, useState } from "react";
import * as xiaolai from "./fonts/XiaolaiSC-Regular.ttf";
import "anipres/anipres.css";
import { IdbDocumentRepository } from "./documents/idb-repository";
import { ApiDocumentRepository } from "./documents/api-repository";
import { DocumentManagerProvider } from "./documents/DocumentManagerContext";
import { SyncedRepositoryProvider } from "./documents/SyncedRepositoryContext";
import { AppContent } from "./AppContent";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";

interface Workspace {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

// Result of a workspace-discovery fetch. The fetched value is tagged
// with the user id it was fetched for, so derived state can treat
// stale entries (after a user-A → user-B transition) as "loading"
// instead of synchronously clearing state from the effect (which the
// React lint rule discourages — it causes a cascading re-render).
type WorkspaceFetchResult =
  | { userId: number; id: string }
  | { userId: number; error: string };

function AuthenticatedApp() {
  const { user, loading: authLoading } = useAuth();
  const localRepository = useMemo(() => new IdbDocumentRepository(), []);

  // Server-side documents are workspace-owned. After login we discover
  // the user's workspaces via `GET /api/workspaces` and bind the synced
  // repo to the (Phase 1: only) workspace returned. Extension A will
  // surface the list to the user; for now we just take the first row.
  const [fetchedWorkspace, setFetchedWorkspace] =
    useState<WorkspaceFetchResult | null>(null);
  useEffect(() => {
    if (!user) return;
    const userId = user.id;
    let cancelled = false;
    fetch("/api/workspaces")
      .then(async (res): Promise<WorkspaceFetchResult> => {
        if (!res.ok) {
          return { userId, error: `request failed (${res.status})` };
        }
        const data: Workspace[] = await res.json();
        if (data.length === 0) {
          return { userId, error: "no workspace found for this account" };
        }
        return { userId, id: data[0].id };
      })
      .catch(
        (err: unknown): WorkspaceFetchResult => ({
          userId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then((next) => {
        if (cancelled) return;
        if ("error" in next) {
          console.error(
            `Workspace discovery failed: ${next.error}. The app cannot reach the server-backed document store.`,
          );
        }
        setFetchedWorkspace(next);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Derived: treat a fetched value belonging to a different user (or no
  // value at all) as "still loading" without touching state.
  const currentWorkspace =
    user && fetchedWorkspace?.userId === user.id ? fetchedWorkspace : null;
  const workspaceId =
    currentWorkspace && "id" in currentWorkspace ? currentWorkspace.id : null;
  const workspaceError =
    currentWorkspace && "error" in currentWorkspace
      ? currentWorkspace.error
      : null;

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
