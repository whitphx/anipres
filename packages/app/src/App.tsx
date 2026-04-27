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

function AuthenticatedApp() {
  const { user, loading: authLoading } = useAuth();
  const localRepository = useMemo(() => new IdbDocumentRepository(), []);

  // Server-side documents are workspace-owned. After login we discover
  // the user's workspaces via `GET /api/workspaces` and bind the synced
  // repo to the (Phase 1: only) workspace returned. Extension A will
  // surface the list to the user; for now we just take the first row.
  //
  // The fetched value is tagged with the user id it was fetched for,
  // so when the auth subject changes we can derive `null` until the
  // new fetch lands instead of synchronously clearing in the effect
  // (which the React lint rule discourages — it causes a cascading
  // re-render).
  const [fetchedWorkspace, setFetchedWorkspace] = useState<{
    userId: number;
    id: string;
  } | null>(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetch("/api/workspaces")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Workspace[] | null) => {
        if (cancelled) return;
        if (data && data.length > 0) {
          setFetchedWorkspace({ userId: user.id, id: data[0].id });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  const workspaceId =
    user && fetchedWorkspace?.userId === user.id ? fetchedWorkspace.id : null;

  const syncedRepository = useMemo(
    () =>
      user !== null && workspaceId !== null
        ? new ApiDocumentRepository(workspaceId)
        : undefined,
    [user, workspaceId],
  );

  // Wait for both auth resolution and (when logged in) workspace
  // discovery before rendering. Without this, a logged-in user would
  // briefly see the local-only experience while the workspace fetch
  // is in flight.
  if (authLoading || (user !== null && workspaceId === null)) {
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
