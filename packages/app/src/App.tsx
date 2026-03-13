import { useMemo } from "react";
import * as xiaolai from "./fonts/XiaolaiSC-Regular.ttf";
import "anipres/anipres.css";
import { IdbDocumentRepository } from "./documents/idb-repository";
import { ApiDocumentRepository } from "./documents/api-repository";
import { DocumentManagerProvider } from "./documents/DocumentManagerContext";
import { AppContent } from "./AppContent";

function isSyncMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has("sync");
}

function App() {
  const synced = useMemo(() => isSyncMode(), []);
  const repository = useMemo(
    () => (synced ? new ApiDocumentRepository() : new IdbDocumentRepository()),
    [synced],
  );

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
      <DocumentManagerProvider repository={repository} synced={synced}>
        <AppContent />
      </DocumentManagerProvider>
    </>
  );
}

export default App;
