import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { WorkspaceFeedRoom } from "./WorkspaceFeedRoom";

function getRoom(name: string) {
  const id = env.WORKSPACE_FEED_ROOM.idFromName(name);
  return env.WORKSPACE_FEED_ROOM.get(id);
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  if (done || value === undefined) {
    throw new Error("stream ended unexpectedly");
  }
  return new TextDecoder().decode(value);
}

// All test bodies run inside `runInDurableObject` so the streams
// stay within the DO instance. Reading streams across the RPC
// boundary works for the production fetch handler but tears down
// noisily when a test exits — keeping the read loop in-DO sidesteps
// the "Network connection lost" tail.

describe("WorkspaceFeedRoom", () => {
  it("delivers a broadcast event to a subscribed stream", async () => {
    const room = getRoom("delivers-event");
    const result = await runInDurableObject(
      room,
      async (instance: WorkspaceFeedRoom) => {
        const stream = await instance.subscribe(null);
        const reader = stream.getReader();
        const initial = await readNextChunk(reader);
        await instance.broadcast({ type: "documents:changed" }, null);
        const event = await readNextChunk(reader);
        await reader.cancel();
        return { initial, event };
      },
    );

    expect(result.initial).toBe(":ok\n\n");
    expect(result.event).toBe('data: {"type":"documents:changed"}\n\n');
  });

  it("filters out broadcasts whose senderId matches the subscriber's clientId", async () => {
    const room = getRoom("self-echo-filter");
    const events = await runInDurableObject(
      room,
      async (instance: WorkspaceFeedRoom) => {
        const stream = await instance.subscribe("client-A");
        const reader = stream.getReader();
        await readNextChunk(reader); // discard ":ok"

        // External, self, external. The middle one must not appear.
        await instance.broadcast({ type: "documents:changed" }, "client-B");
        await instance.broadcast({ type: "documents:changed" }, "client-A");
        await instance.broadcast({ type: "documents:changed" }, "client-C");

        const first = await readNextChunk(reader);
        const second = await readNextChunk(reader);
        await reader.cancel();
        return [first, second];
      },
    );

    expect(events).toEqual([
      'data: {"type":"documents:changed"}\n\n',
      'data: {"type":"documents:changed"}\n\n',
    ]);
  });

  it("delivers broadcasts to multiple subscribers", async () => {
    const room = getRoom("fanout-multi");
    const result = await runInDurableObject(
      room,
      async (instance: WorkspaceFeedRoom) => {
        const streamA = await instance.subscribe("client-A");
        const streamB = await instance.subscribe("client-B");
        const readerA = streamA.getReader();
        const readerB = streamB.getReader();
        await readNextChunk(readerA);
        await readNextChunk(readerB);

        await instance.broadcast({ type: "documents:changed" }, null);

        const eventA = await readNextChunk(readerA);
        const eventB = await readNextChunk(readerB);
        await readerA.cancel();
        await readerB.cancel();
        return { eventA, eventB };
      },
    );

    expect(result.eventA).toBe('data: {"type":"documents:changed"}\n\n');
    expect(result.eventB).toBe('data: {"type":"documents:changed"}\n\n');
  });

  it("does not echo self-broadcasts but still reaches sibling subscribers", async () => {
    const room = getRoom("fanout-self-and-others");
    const result = await runInDurableObject(
      room,
      async (instance: WorkspaceFeedRoom) => {
        const streamA = await instance.subscribe("client-A");
        const streamB = await instance.subscribe("client-B");
        const readerA = streamA.getReader();
        const readerB = streamB.getReader();
        await readNextChunk(readerA);
        await readNextChunk(readerB);

        // From A — reaches B, not A.
        await instance.broadcast({ type: "documents:changed" }, "client-A");
        const bFirst = await readNextChunk(readerB);

        // External anchor that A does see — landing on this chunk
        // proves A skipped the self-echo without needing a timeout.
        await instance.broadcast({ type: "documents:changed" }, "client-C");
        const aFirst = await readNextChunk(readerA);

        await readerA.cancel();
        await readerB.cancel();
        return { aFirst, bFirst };
      },
    );

    expect(result.aFirst).toBe('data: {"type":"documents:changed"}\n\n');
    expect(result.bFirst).toBe('data: {"type":"documents:changed"}\n\n');
  });
});
