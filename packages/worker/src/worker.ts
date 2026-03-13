import { Hono } from "hono";
import { cors } from "hono/cors";

export { TldrawDurableObject } from "./TldrawDurableObject";

interface Env {
  TLDRAW_DURABLE_OBJECT: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/api/connect/:roomId", (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.TLDRAW_DURABLE_OBJECT.idFromName(roomId);
  const room = c.env.TLDRAW_DURABLE_OBJECT.get(id);

  const url = new URL(c.req.url);
  return room.fetch(url.toString(), {
    headers: c.req.raw.headers,
  });
});

export default app;
