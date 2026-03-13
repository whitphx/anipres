import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { AppLayout } from "./components/AppLayout";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";
import { SyncedAnipresContainer } from "./components/SyncedAnipresContainer";
import { useColorScheme } from "./hooks/useColorScheme";

export function AppContent() {
  const { activeDocumentId, activeSnapshot, loading, synced } =
    useDocumentManagerContext();

  const { preference, changePreference } = useColorScheme();

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
      {activeDocumentId &&
        (synced ? (
          <SyncedAnipresContainer
            key={activeDocumentId}
            roomId={activeDocumentId}
            colorScheme={preference}
          />
        ) : (
          <AnipresContainer
            key={activeDocumentId}
            documentId={activeDocumentId}
            snapshot={activeSnapshot}
            colorScheme={preference}
          />
        ))}
    </AppLayout>
  );
}
