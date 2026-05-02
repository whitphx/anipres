import { DurableObject } from "cloudflare:workers";
import type { AppContext, Env as WorkerEnv } from "./types";

// Idle keepalive cadence. EventSource through any of the usual
// proxies (Cloudflare's own edge, customer proxies, mobile carriers)
// can drop a stream that has been silent for a few minutes; sending
// an SSE comment line ":\n\n" every 30s keeps the path warm without
// reaching the user-facing onmessage handler.
const KEEPALIVE_MS = 30_000;

export type WorkspaceFeedEvent = { type: "documents:changed" };

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Per-tab id from the EventSource handshake (`?client_id=`). When
  // a mutation route bumps with a senderId equal to this, the
  // broadcast skips this subscriber — the originating tab already
  // updated its view via the mutation response.
  clientId: string | null;
}

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
  private subscribers = new Set<Subscriber>();
  private encoder = new TextEncoder();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  async subscribe(clientId: string | null): Promise<ReadableStream<Uint8Array>> {
    let mySubscriber: Subscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        mySubscriber = { controller, clientId };
        this.subscribers.add(mySubscriber);
        // Initial SSE comment flushes headers immediately and lets
        // the client know the stream is open.
        controller.enqueue(this.encoder.encode(":ok\n\n"));
        this.ensureKeepalive();
      },
      cancel: () => {
        if (mySubscriber) {
          this.subscribers.delete(mySubscriber);
          this.maybeStopKeepalive();
        }
      },
    });
    return stream;
  }

  async broadcast(
    event: WorkspaceFeedEvent,
    senderId: string | null,
  ): Promise<void> {
    const payload = this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    this.fanOut(payload, senderId);
  }

  // A subscriber that disconnects without firing `cancel` (network
  // drop, suspended mobile tab) leaves itself in the set until the
  // next enqueue throws. The keepalive's periodic fanOut bounds that
  // linger window to ~KEEPALIVE_MS so dead subscribers get culled on
  // a regular cadence even when no real broadcasts are in flight.
  private fanOut(payload: Uint8Array, senderId: string | null) {
    const dead: Subscriber[] = [];
    for (const subscriber of this.subscribers) {
      if (senderId !== null && subscriber.clientId === senderId) continue;
      try {
        subscriber.controller.enqueue(payload);
      } catch {
        dead.push(subscriber);
      }
    }
    for (const subscriber of dead) {
      this.subscribers.delete(subscriber);
    }
    this.maybeStopKeepalive();
  }

  private ensureKeepalive() {
    if (this.keepaliveTimer !== null) return;
    this.keepaliveTimer = setInterval(() => {
      // Keepalive is a comment line (no `senderId` filtering needed
      // — comments don't reach `onmessage` anyway) sent to every
      // active subscriber.
      this.fanOut(this.encoder.encode(`:ka\n\n`), null);
    }, KEEPALIVE_MS);
  }

  private maybeStopKeepalive() {
    if (this.subscribers.size === 0 && this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}

// Header set by the app's API client on every request. Mutation
// routes pass this through to the DO so the originating tab's SSE
// subscriber doesn't get its own bump echoed back as a redundant
// doc-list refetch.
export const CLIENT_ID_HEADER = "X-Anipres-Client-Id";

export function bumpWorkspaceFeed(c: AppContext, workspaceId: number) {
  const senderId = c.req.header(CLIENT_ID_HEADER) ?? null;
  const ns = c.env.WORKSPACE_FEED_ROOM;
  const stub = ns.get(ns.idFromName(`workspace:${workspaceId}`));
  // Fire-and-forget: a dropped notification is recoverable via the
  // client's refreshInterval polling backstop, so don't make the
  // mutation response wait on the DO RPC.
  c.executionCtx.waitUntil(
    stub.broadcast({ type: "documents:changed" }, senderId),
  );
}
