import { useDocumentManagerContext } from "./documents/useDocumentManagerContext";
import { AppLayout } from "./components/AppLayout";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AnipresContainer } from "./components/AnipresContainer";

export function AppContent() {
  const { activeDocumentId, activeSnapshot, loading } =
    useDocumentManagerContext();

  if (loading) {
    return null;
  }

  return (
    <AppLayout sidebar={<DocumentSidebar />}>
      {activeDocumentId && (
        <AnipresContainer
          key={activeDocumentId}
          documentId={activeDocumentId}
          snapshot={activeSnapshot}
        />
      )}
    </AppLayout>
  );
}
