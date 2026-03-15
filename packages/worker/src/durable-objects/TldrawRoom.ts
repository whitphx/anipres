import { DurableObject } from "cloudflare:workers";
import { TLSocketRoom, type RoomSnapshot } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { anipresSchema } from "anipres/schema";

const ROOM_SNAPSHOT_KEY = "room_snapshot";

type RoomEnv = Record<string, never>;
type SessionAttachment = {
  sessionId: string;
};

export class TldrawRoom extends DurableObject<RoomEnv> {
  private readonly room: TLSocketRoom<TLRecord>;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);

    this.room = new TLSocketRoom<TLRecord>({
      schema: anipresSchema,
      onDataChange: () => {
        void this.ctx.storage.put(
          ROOM_SNAPSHOT_KEY,
          this.room.getCurrentSnapshot(),
        );
      },
    });

    ctx.blockConcurrencyWhile(async () => {
      const snapshot =
        await this.ctx.storage.get<RoomSnapshot>(ROOM_SNAPSHOT_KEY);
      if (snapshot) {
        this.room.loadSnapshot(snapshot);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId query parameter", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ sessionId } satisfies SessionAttachment);
    this.ctx.acceptWebSocket(server);
    this.room.handleSocketConnect({
      sessionId,
      socket: {
        close: (...args) => server.close(...args),
        get readyState() {
          return server.readyState;
        },
        send: (data) => server.send(data),
      },
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const sessionId = this.getSessionId(ws);
    if (!sessionId) {
      ws.close(1011, "Missing session metadata");
      return;
    }

    this.room.handleSocketMessage(sessionId, message);
  }

  override webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ) {
    const sessionId = this.getSessionId(ws);
    if (!sessionId) {
      return;
    }

    this.room.handleSocketClose(sessionId);
  }

  override webSocketError(ws: WebSocket, _error: unknown) {
    const sessionId = this.getSessionId(ws);
    if (!sessionId) {
      return;
    }

    this.room.handleSocketError(sessionId);
  }

  private getSessionId(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    return attachment?.sessionId ?? null;
  }
}
