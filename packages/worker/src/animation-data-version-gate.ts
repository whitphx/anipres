import {
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import {
  getAnimationDataVersionGateResponse,
  isAnimationDataVersionAllowed,
} from "./animation-data-version";

// Worker-only (uses WebSocketPair); the app imports the shared constants
// from ./animation-data-version instead.

/**
 * Version gate for the sync surface. A failing WebSocket upgrade is
 * rejected IN-PROTOCOL: the upgrade is accepted and the socket
 * immediately closed with tldraw's sync-error close code and
 * `CLIENT_TOO_OLD` — the same mechanism `TLSocketRoom` uses for its own
 * protocol-version rejections (see
 * https://github.com/tldraw/tldraw/blob/v3.15.5/packages/sync-core/src/lib/TLSyncClient.ts
 * for the close-code contract) — so `useSync` surfaces a
 * `TLRemoteSyncError("CLIENT_TOO_OLD")` the app can show a reload screen
 * for. Rejecting with an HTTP status before the upgrade would instead
 * surface as close code 1006, which the client treats as a transient
 * network failure and retries forever.
 */
export function getSyncAnimationDataVersionGateResponse(
  request: Request,
): Response | undefined {
  if (isAnimationDataVersionAllowed(request)) {
    return undefined;
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return getAnimationDataVersionGateResponse(request);
  }
  const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
  serverWebSocket.accept();
  serverWebSocket.close(
    TLSyncErrorCloseEventCode,
    TLSyncErrorCloseEventReason.CLIENT_TOO_OLD,
  );
  return new Response(null, { status: 101, webSocket: clientWebSocket });
}
