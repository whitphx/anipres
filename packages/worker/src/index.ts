import { Hono } from "hono";
import { TldrawRoom } from "./durable-objects/TldrawRoom";

export interface Env {
  TLDRAW_ROOM: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.json({
    ok: true,
    service: "anipres-worker",
  });
});

app.get("/rooms/:id", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected websocket upgrade", 426);
  }

  const roomId = c.req.param("id");
  const roomStub = c.env.TLDRAW_ROOM.get(c.env.TLDRAW_ROOM.idFromName(roomId));
  return roomStub.fetch(c.req.raw);
});

export default app;
export { TldrawRoom };
