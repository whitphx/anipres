// Per-tab identifier used wherever a self-echo needs to be
// filtered:
//
// - On every API request (header) + the EventSource handshake
//   (`?client_id=`), so the WorkspaceFeedRoom DO can skip fanOut
//   to the originating tab on its own bumps.
// - On BroadcastChannel posts (local-docs-broadcast,
//   auth-broadcast), so a tab listening on the same channel name
//   it just posted to ignores its own message.
//
// Generated once at module load — fresh tab → fresh id. Generic
// uniqueness is enough; this is not a security boundary.
export const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

export const CLIENT_ID_HEADER = "X-Anipres-Client-Id";
