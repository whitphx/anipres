import { createContext, useContext } from "react";
import type { ApiDocumentRepository } from "./api-repository";

// Carried through context so the workspace-bound instance is shared
// across consumers (the DocumentManagerProvider and the reconnect/
// fork flow) without reconstructing or prop-threading.
export const SyncedRepositoryContext =
  createContext<ApiDocumentRepository | null>(null);

/**
 * Read the synced repository from context. Returns `null` when the
 * user is logged out — callers should handle that case (typically by
 * rendering an unauthenticated UI instead of attempting a sync flow).
 */
export function useSyncedRepository(): ApiDocumentRepository | null {
  return useContext(SyncedRepositoryContext);
}
