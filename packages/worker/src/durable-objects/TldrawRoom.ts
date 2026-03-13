import { type RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
import type { TLRecord } from "tldraw";
import { DurableObject } from "cloudflare:workers";
import { anipresSchema } from "../schema";

const PERSIST_INTERVAL_MS = 10_000;

export class TldrawRoom extends DurableObject {
  private roomPromise: Promise<TLSocketRoom<TLRecord, void>> | null = null;
  private persistTimeout: ReturnType<typeof setTimeout> | null = null;

  private getRoom(): Promise<TLSocketRoom<TLRecord, void>> {
    if (!this.roomPromise) {
      this.roomPromise = (async () => {
        const stored = await this.ctx.storage.get<RoomSnapshot>("snapshot");

        return new TLSocketRoom<TLRecord, void>({
          schema: anipresSchema,
          initialSnapshot: stored ?? undefined,
          onDataChange: () => {
            this.schedulePersist();
          },
        });
      })();
    }
    return this.roomPromise;
  }

  private schedulePersist() {
    if (this.persistTimeout) return;
    this.persistTimeout = setTimeout(async () => {
      this.persistTimeout = null;
      if (!this.roomPromise) return;
      const room = await this.getRoom();
      const snapshot = room.getCurrentSnapshot();
      await this.ctx.storage.put("snapshot", snapshot);
    }, PERSIST_INTERVAL_MS);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    const room = await this.getRoom();
    room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }
}
