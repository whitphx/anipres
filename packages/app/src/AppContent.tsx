import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { AppLayout } from "./components/AppLayout";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";
import { SyncedAnipresContainer } from "./components/SyncedAnipresContainer";
import { useColorScheme } from "./hooks/useColorScheme";

function useSyncParams() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  const server = params.get("server") ?? window.location.origin;
  return room ? { room, server } : null;
}

export function AppContent() {
  const syncParams = useSyncParams();
  const { activeDocumentId, activeSnapshot, loading } =
    useDocumentManagerContext();

  const { preference, changePreference } = useColorScheme();

  if (syncParams) {
    return (
      <SyncedAnipresContainer
        roomId={syncParams.room}
        serverBaseUrl={syncParams.server}
        colorScheme={preference}
      />
    );
  }

  if (loading) {
    return null;
  }

  return (
    <AppLayout
      sidebar={
        <DocumentSidebar
          colorSchemePreference={preference}
          onColorSchemeChange={changePreference}
        />
      }
    >
      {activeDocumentId && (
        <AnipresContainer
          key={activeDocumentId}
          documentId={activeDocumentId}
          snapshot={activeSnapshot}
          colorScheme={preference}
        />
      )}
    </AppLayout>
  );
}
