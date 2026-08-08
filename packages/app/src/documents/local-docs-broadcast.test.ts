import { afterEach, describe, expect, it, vi } from "vitest";
import {
  broadcastLocalDocsChanged,
  subscribeToLocalDocsChanges,
} from "./local-docs-broadcast";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!();
  }
});

// See auth-broadcast.test.ts for why the waits must be event-based:
// Node's BroadcastChannel has no same-turn delivery guarantee.
function nextBroadcast(): Promise<void> {
  return new Promise((resolve) => {
    const control = new BroadcastChannel("anipres:local-docs");
    cleanups.push(() => control.close());
    control.onmessage = () => {
      resolve();
    };
  });
}

// Same-realm BroadcastChannel cross-instance behavior is what's
// being exercised: a message posted on a fresh "anipres:local-docs"
// channel should reach a subscriber on a separate channel of the
// same name, except when the sender id matches.
describe("local-docs broadcast", () => {
  it("delivers to a subscriber when the broadcast comes from another sender", async () => {
    const handler = vi.fn();
    cleanups.push(subscribeToLocalDocsChanges(handler));

    // Simulate "another tab" by posting raw on the same channel name
    // — that channel has a different sender id by construction.
    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("ignores broadcasts originated by the same tab", async () => {
    const handler = vi.fn();
    cleanups.push(subscribeToLocalDocsChanges(handler));

    const delivered = nextBroadcast();
    broadcastLocalDocsChanged();
    await delivered;
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToLocalDocsChanges(handler);
    unsubscribe();

    const delivered = nextBroadcast();
    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();
    await delivered;
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });
});
