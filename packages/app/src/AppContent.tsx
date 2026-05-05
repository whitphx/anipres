import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { AppLayout } from "./components/AppLayout";
import { ChatPanel } from "./components/ChatPanel";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";
import { OfflineAwareSyncedContainer } from "./components/OfflineAwareSyncedContainer";
import { useColorScheme } from "./hooks/useColorScheme";

export function AppContent() {
  const { activeDocument, activeSnapshot, loading } =
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
      chatPanel={<ChatPanel />}
    >
      {activeDocument &&
        (activeDocument.source === "synced" ? (
          <OfflineAwareSyncedContainer
            key={activeDocument.id}
            documentId={activeDocument.id}
            colorScheme={preference}
          />
        ) : (
          <AnipresContainer
            key={activeDocument.id}
            documentId={activeDocument.id}
            snapshot={activeSnapshot}
            colorScheme={preference}
          />
        ))}
    </AppLayout>
  );
}
