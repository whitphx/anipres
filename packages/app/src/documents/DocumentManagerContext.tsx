import type { ReactNode } from "react";
import type { DocumentRepository } from "./repository";
import { useDocumentManager } from "./useDocumentManager";
import { DocumentManagerContext } from "./useDocumentManagerContext";

export function DocumentManagerProvider({
  repository,
  synced,
  children,
}: {
  repository: DocumentRepository;
  synced?: boolean;
  children: ReactNode;
}) {
  const manager = useDocumentManager(repository, { synced });
  return (
    <DocumentManagerContext.Provider value={manager}>
      {children}
    </DocumentManagerContext.Provider>
  );
}
