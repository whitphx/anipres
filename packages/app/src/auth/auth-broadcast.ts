import { CLIENT_ID } from "../lib/client-id";

const CHANNEL_NAME = "anipres:auth";

interface AuthBroadcastMessage {
  type: "logout";
  senderId: string;
}

export function broadcastLogout(): void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const payload: AuthBroadcastMessage = { type: "logout", senderId: CLIENT_ID };
  channel.postMessage(payload);
  channel.close();
}

export function subscribeToAuthBroadcasts(
  handler: (message: AuthBroadcastMessage) => void,
): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<AuthBroadcastMessage>) => {
    const data = event.data;
    if (!data || data.senderId === CLIENT_ID) return;
    handler(data);
  };
  return () => channel.close();
}
