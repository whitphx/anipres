import { Hono } from "hono";

export { DocumentSyncRoom } from "./DocumentSyncRoom";

interface Env {
  DOCUMENT_SYNC_ROOM: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/connect/:roomId", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const roomId = c.req.param("roomId");
  const id = c.env.DOCUMENT_SYNC_ROOM.idFromName(roomId);
  const room = c.env.DOCUMENT_SYNC_ROOM.get(id);

  return room.fetch(c.req.raw);
});

export default app;
