import type { ReactNode } from "react";
import type { DocumentRepository, LocalDocumentRepository } from "./repository";
import { useDocumentManager } from "./useDocumentManager";
import { DocumentManagerContext } from "./useDocumentManagerContext";
import { useWorkspaceFeed } from "./useWorkspaceFeed";

export function DocumentManagerProvider({
  localRepository,
  syncedRepository,
  workspaceId,
  children,
}: {
  localRepository: LocalDocumentRepository;
  syncedRepository?: DocumentRepository;
  workspaceId: string | null;
  children: ReactNode;
}) {
  const manager = useDocumentManager({ localRepository, syncedRepository });
  useWorkspaceFeed(workspaceId, manager.refreshDocuments);
  return (
    <DocumentManagerContext.Provider value={manager}>
      {children}
    </DocumentManagerContext.Provider>
  );
}
