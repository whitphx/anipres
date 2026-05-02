import { CLIENT_ID } from "../lib/client-id";

const CHANNEL_NAME = "anipres:local-docs";

// BroadcastChannel only suppresses echoes on the *same* instance,
// but subscribe + broadcast use separate instances (one is long-lived
// in the listener, one is opened per post). The per-tab CLIENT_ID
// stamps every payload so the listener can drop its own posts.

interface LocalDocsMessage {
  senderId: string;
}

export function broadcastLocalDocsChanged(): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const payload: LocalDocsMessage = { senderId: CLIENT_ID };
  channel.postMessage(payload);
  channel.close();
}

export function subscribeToLocalDocsChanges(handler: () => void): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<LocalDocsMessage>) => {
    if (event.data?.senderId === CLIENT_ID) return;
    handler();
  };
  return () => channel.close();
}
