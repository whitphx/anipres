import { useMemo } from "react";
import * as xiaolai from "./fonts/XiaolaiSC-Regular.ttf";
import "anipres/anipres.css";
import { IdbDocumentRepository } from "./documents/idb-repository";
import { ApiDocumentRepository } from "./documents/api-repository";
import { DocumentManagerProvider } from "./documents/DocumentManagerContext";
import { AppContent } from "./AppContent";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";

function AuthenticatedApp() {
  const { user, loading: authLoading } = useAuth();
  const localRepository = useMemo(() => new IdbDocumentRepository(), []);
  const syncedRepository = useMemo(
    () => (user !== null ? new ApiDocumentRepository() : undefined),
    [user],
  );

  if (authLoading) {
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
      <DocumentManagerProvider
        localRepository={localRepository}
        syncedRepository={syncedRepository}
      >
        <AppContent />
      </DocumentManagerProvider>
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
