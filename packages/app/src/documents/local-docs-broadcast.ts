const CHANNEL_NAME = "anipres:local-docs";

// Stable per-tab id used to filter the listener's own posts. Without
// this, broadcasting from one channel and listening on another in
// the same tab (which subscribe + broadcast must do, since
// BroadcastChannel only suppresses echoes on the *same* instance)
// would loop the sender's own message back into its receiver.
const TAB_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

interface LocalDocsMessage {
  senderId: string;
}

export function broadcastLocalDocsChanged(): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const payload: LocalDocsMessage = { senderId: TAB_ID };
  channel.postMessage(payload);
  channel.close();
}

export function subscribeToLocalDocsChanges(handler: () => void): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<LocalDocsMessage>) => {
    if (event.data?.senderId === TAB_ID) return;
    handler();
  };
  return () => channel.close();
}
