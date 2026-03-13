import { Hono } from "hono";

export { TldrawDurableObject } from "./TldrawDurableObject";

interface Env {
  TLDRAW_DURABLE_OBJECT: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/connect/:roomId", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const roomId = c.req.param("roomId");
  const id = c.env.TLDRAW_DURABLE_OBJECT.idFromName(roomId);
  const room = c.env.TLDRAW_DURABLE_OBJECT.get(id);

  return room.fetch(c.req.raw);
});

export default app;
