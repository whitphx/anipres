import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { AppLayout } from "./components/AppLayout";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";
import { SyncedAnipresContainer } from "./components/SyncedAnipresContainer";
import { useColorScheme } from "./hooks/useColorScheme";

function getSyncRoomId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("sync");
}

export function AppContent() {
  const syncRoomId = getSyncRoomId();
  const { activeDocumentId, activeSnapshot, loading } =
    useDocumentManagerContext();

  const { preference, changePreference } = useColorScheme();

  if (syncRoomId) {
    return (
      <SyncedAnipresContainer roomId={syncRoomId} colorScheme={preference} />
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
