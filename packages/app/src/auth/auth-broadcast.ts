const CHANNEL_NAME = "anipres:auth";

// Stable per-tab id used to filter the listener's own posts. Same
// pattern as local-docs-broadcast — see that file for the rationale.
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

interface AuthBroadcastMessage {
  type: "logout";
  senderId: string;
}

export function broadcastLogout(): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const payload: AuthBroadcastMessage = { type: "logout", senderId: TAB_ID };
  channel.postMessage(payload);
  channel.close();
}

export function subscribeToAuthBroadcasts(
  handler: (message: AuthBroadcastMessage) => void,
): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<AuthBroadcastMessage>) => {
    const data = event.data;
    if (!data || data.senderId === TAB_ID) return;
    handler(data);
  };
  return () => channel.close();
}
