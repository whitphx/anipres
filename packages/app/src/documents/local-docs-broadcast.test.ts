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

// Same-realm BroadcastChannel cross-instance behavior is what's
// being exercised: a message posted on a fresh "anipres:local-docs"
// channel should reach a subscriber on a separate channel of the
// same name, except when the sender id matches. See
// auth-broadcast.test.ts for why the waits synchronize on delivery
// instead of sleeping: Node's BroadcastChannel has no same-turn
// delivery guarantee.
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
    // The subject handler takes no payload, so a bare call count can't
    // distinguish "filtered the own-tab message" from "the external
    // message hasn't arrived yet". The witness closes that gap: created
    // after the subject, it is served each message after the subject
    // is, so once it has seen the external message the subject has
    // fully processed both messages and its count is final.
    const witness = vi.fn();
    cleanups.push(subscribeToLocalDocsChanges(witness));

    broadcastLocalDocsChanged();
    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(witness).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToLocalDocsChanges(handler);
    unsubscribe();
    // A second, still-open subscriber proves the message went out.
    const witness = vi.fn();
    cleanups.push(subscribeToLocalDocsChanges(witness));

    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(witness).toHaveBeenCalledTimes(1));
    expect(handler).not.toHaveBeenCalled();
  });
});
