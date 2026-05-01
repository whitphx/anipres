// Per-tab client identifier sent on every API request and on the
// EventSource handshake. The worker stamps it onto each
// "documents:changed" SSE broadcast and the WorkspaceFeedRoom DO
// suppresses fanOut to subscribers whose id matches — so a tab
// doesn't get its own mutations echoed back as a redundant doc-list
// refetch a moment after the mutation response already updated
// local state.
//
// Generated once at module load — fresh tab → fresh id. Generic
// uniqueness is enough; this is not a security boundary.
export const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export const CLIENT_ID_HEADER = "X-Anipres-Client-Id";
