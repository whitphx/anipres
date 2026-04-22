import type { ReactNode } from "react";
import type { DocumentRepository } from "./repository";
import { useDocumentManager } from "./useDocumentManager";
import { DocumentManagerContext } from "./useDocumentManagerContext";

export function DocumentManagerProvider({
  localRepository,
  syncedRepository,
  children,
}: {
  localRepository: DocumentRepository;
  syncedRepository?: DocumentRepository;
  children: ReactNode;
}) {
  const manager = useDocumentManager({ localRepository, syncedRepository });
  return (
    <DocumentManagerContext.Provider value={manager}>
      {children}
    </DocumentManagerContext.Provider>
  );
}
