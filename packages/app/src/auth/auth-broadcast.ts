import { CLIENT_ID } from "../lib/client-id";

// Logout-only by intent. Logout is urgent: once the cookie is
// cleared, every other tab's API calls 401 — stale "logged in"
// state is harmful. Login is the reverse: stale "logged out" is
// benign (shows the login button, no 401s) and SWR's focus
// revalidation picks up the new session on next tab focus. Login
// also lacks a clean trigger to broadcast from — it arrives via a
// full-page redirect, not a programmatic call.

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
