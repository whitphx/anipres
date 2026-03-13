import { Hono } from "hono";

export { TldrawRoom } from "./durable-objects/TldrawRoom";

type Env = {
  Bindings: {
    TLDRAW_ROOM: DurableObjectNamespace;
  };
};

const app = new Hono<Env>();

app.get("/api/health", (c) => {
  return c.json({ status: "ok" });
});

app.get("/api/rooms/:roomId", (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const roomId = c.req.param("roomId");
  const id = c.env.TLDRAW_ROOM.idFromName(roomId);
  const stub = c.env.TLDRAW_ROOM.get(id);

  return stub.fetch(c.req.raw);
});

export default app;
