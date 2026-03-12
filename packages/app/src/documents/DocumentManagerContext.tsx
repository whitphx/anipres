import type { ReactNode } from "react";
import type { DocumentRepository } from "./repository";
import { useDocumentManager } from "./useDocumentManager";
import { DocumentManagerContext } from "./useDocumentManagerContext";

export function DocumentManagerProvider({
  repository,
  children,
}: {
  repository: DocumentRepository;
  children: ReactNode;
}) {
  const manager = useDocumentManager(repository);
  return (
    <DocumentManagerContext.Provider value={manager}>
      {children}
    </DocumentManagerContext.Provider>
  );
}
