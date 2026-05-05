import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { useAuth } from "./auth/useAuth";
import { AppLayout } from "./components/AppLayout";
import { AgentLoginPromo } from "./components/AgentLoginPromo";
import { ChatPanel } from "./components/ChatPanel";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";
import { OfflineAwareSyncedContainer } from "./components/OfflineAwareSyncedContainer";
import { useColorScheme } from "./hooks/useColorScheme";

export function AppContent() {
  const { activeDocument, activeSnapshot, loading } =
    useDocumentManagerContext();
  const { user, loading: authLoading } = useAuth();

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
      chatPanel={
        // Hold the slot empty during the brief auth-resolution window
        // so authenticated users don't flash the sign-in promo on
        // first paint before their session lands.
        authLoading ? null : user ? <ChatPanel /> : <AgentLoginPromo />
      }
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
