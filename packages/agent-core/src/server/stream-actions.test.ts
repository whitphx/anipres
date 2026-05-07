import { describe, expect, it } from "vitest";
import { parseActionStream } from "./stream-actions.js";
import type { Streaming } from "../types/streaming.js";
import type { AgentAction } from "../schemas/agent-action.js";

async function* fromChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function collect(
  stream: AsyncIterable<Streaming<AgentAction>>,
): Promise<Streaming<AgentAction>[]> {
  const out: Streaming<AgentAction>[] = [];
  for await (const a of stream) out.push(a);
  return out;
}

describe("parseActionStream", () => {
  it("yields each action as incomplete then complete", async () => {
    // The stream-actions seed buffer is `'{"actions": [{"_type":'`, so the
    // chunks here pick up from immediately after that opening.
    const chunks = [
      '"message","text":"hello"}',
      ',{"_type":"message","text":"world"}',
      "]}",
    ];

    const out = await collect(parseActionStream(fromChunks(chunks)));

    // Exactly two completes, plus an incomplete for each before its complete.
    const completes = out.filter((a) => a.complete);
    expect(completes).toHaveLength(2);
    expect(completes[0]).toMatchObject({
      _type: "message",
      text: "hello",
      complete: true,
    });
    expect(completes[1]).toMatchObject({
      _type: "message",
      text: "world",
      complete: true,
    });

    // First emission for any action is the incomplete version.
    const firstHello = out.findIndex(
      (a) => a._type === "message" && a.text === "hello",
    );
    expect(out[firstHello].complete).toBe(false);
  });

  it("produces no actions for an empty stream", async () => {
    const out = await collect(parseActionStream(fromChunks([])));
    expect(out).toEqual([]);
  });

  it("flushes the final action as complete on stream end", async () => {
    const chunks = ['"message","text":"only"}'];
    const out = await collect(parseActionStream(fromChunks(chunks)));
    const completes = out.filter((a) => a.complete);
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ _type: "message", text: "only" });
  });

  it("flushes every action when multiple arrive in a single chunk", async () => {
    // Three complete actions delivered in one chunk — the cursor has to
    // catch up to the tail or middle actions never reach `complete:
    // true` and downstream consumers (canvas mutations) gate on that.
    const chunks = [
      '"message","text":"a"},{"_type":"message","text":"b"},{"_type":"message","text":"c"}]}',
    ];

    const out = await collect(parseActionStream(fromChunks(chunks)));

    const completes = out.filter((a) => a.complete);
    expect(completes).toHaveLength(3);
    expect(completes.map((a) => (a as { text: string }).text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
