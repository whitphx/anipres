import { DurableObject } from "cloudflare:workers";
import type { AppContext, Env as WorkerEnv } from "./types";

// Idle keepalive cadence. EventSource through any of the usual
// proxies (Cloudflare's own edge, customer proxies, mobile carriers)
// can drop a stream that has been silent for a few minutes; sending
// an SSE comment line ":\n\n" every 30s keeps the path warm without
// reaching the user-facing onmessage handler.
const KEEPALIVE_MS = 30_000;

export type WorkspaceFeedEvent = { type: "documents:changed" };

/**
 * Per-workspace transient pubsub. One DO instance per workspace
 * holds the live SSE subscriber list in memory. Mutation routes call
 * `broadcast()` after committing changes; subscribers receive a
 * "documents:changed" event and refetch the list.
 *
 * No persisted storage — if the DO restarts, subscribers reconnect
 * via EventSource's built-in retry, and the client's polling
 * backstop covers anything missed in the gap.
 */
export class WorkspaceFeedRoom extends DurableObject<WorkerEnv> {
  private subscribers = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();
  private encoder = new TextEncoder();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  async subscribe(): Promise<ReadableStream<Uint8Array>> {
    let myController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        myController = controller;
        this.subscribers.add(controller);
        // Initial SSE comment flushes headers immediately and lets
        // the client know the stream is open.
        controller.enqueue(this.encoder.encode(":ok\n\n"));
        this.ensureKeepalive();
      },
      cancel: () => {
        if (myController) {
          this.subscribers.delete(myController);
          this.maybeStopKeepalive();
        }
      },
    });
    return stream;
  }

  async broadcast(event: WorkspaceFeedEvent): Promise<void> {
    const payload = this.encoder.encode(
      `data: ${JSON.stringify(event)}\n\n`,
    );
    this.fanOut(payload);
  }

  private fanOut(payload: Uint8Array) {
    const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(payload);
      } catch {
        dead.push(controller);
      }
    }
    for (const controller of dead) {
      this.subscribers.delete(controller);
    }
    this.maybeStopKeepalive();
  }

  private ensureKeepalive() {
    if (this.keepaliveTimer !== null) return;
    this.keepaliveTimer = setInterval(() => {
      this.fanOut(this.encoder.encode(`:ka\n\n`));
    }, KEEPALIVE_MS);
  }

  private maybeStopKeepalive() {
    if (this.subscribers.size === 0 && this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

export function bumpWorkspaceFeed(c: AppContext, workspaceId: number) {
  const ns = c.env.WORKSPACE_FEED_ROOM;
  const stub = ns.get(ns.idFromName(`workspace:${workspaceId}`));
  // Fire-and-forget: a dropped notification is recoverable via the
  // client's refreshInterval polling backstop, so don't make the
  // mutation response wait on the DO RPC.
  c.executionCtx.waitUntil(stub.broadcast({ type: "documents:changed" }));
}
