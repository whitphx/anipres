import { TLSocketRoom } from "@tldraw/sync-core";
import { createTLSchema, defaultShapeSchemas } from "tldraw";
import type { TLRecord } from "tldraw";
import { DurableObject } from "cloudflare:workers";
import { customShapeSchemas } from "anipres/schema";

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    ...customShapeSchemas,
  },
});

interface Env {
  TLDRAW_DURABLE_OBJECT: DurableObjectNamespace;
}

export class TldrawDurableObject extends DurableObject<Env> {
  private room: TLSocketRoom<TLRecord, void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Phase 1 POC: no persistence — data lives only while the DO is active.
    // A future phase will add SQLite-backed persistence.
    this.room = new TLSocketRoom<TLRecord, void>({
      schema: schema as any,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    this.room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }
}
