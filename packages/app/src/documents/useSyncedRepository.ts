import { createContext, useContext } from "react";
import type { ApiDocumentRepository } from "./api-repository";

// The synced (server-backed) document repository is workspace-scoped:
// every instance is bound to a single workspace_id resolved after
// login. Two consumers need it — the DocumentManagerProvider for
// list/get/create/update/delete, and the OfflineAwareSyncedContainer
// for the reconnect/fork flow. Carrying the same instance through a
// context avoids constructing it twice or threading it through
// component props.
//
// The context value is `null` when the user is logged out (no synced
// repo exists). Consumers in the synced-only paths must guard against
// that case.
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
