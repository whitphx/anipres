import type { ReactNode } from "react";
import type { ApiDocumentRepository } from "./api-repository";
import { SyncedRepositoryContext } from "./useSyncedRepository";

export function SyncedRepositoryProvider({
  repository,
  children,
}: {
  repository: ApiDocumentRepository | null;
  children: ReactNode;
}) {
  return (
    <SyncedRepositoryContext.Provider value={repository}>
      {children}
    </SyncedRepositoryContext.Provider>
  );
}
