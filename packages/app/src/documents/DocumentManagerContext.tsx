import { createContext, type ReactNode } from "react";
import type { DocumentRepository } from "./repository";
import { useDocumentManager, type DocumentManager } from "./useDocumentManager";

export const DocumentManagerContext = createContext<DocumentManager | null>(
  null,
);

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
