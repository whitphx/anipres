import { describe, expect, it, vi } from "vitest";
import {
  broadcastLocalDocsChanged,
  subscribeToLocalDocsChanges,
} from "./local-docs-broadcast";

// Same-realm BroadcastChannel cross-instance behavior is what's
// being exercised: a message posted on a fresh "anipres:local-docs"
// channel should reach a subscriber on a separate channel of the
// same name, except when the sender id matches.
describe("local-docs broadcast", () => {
  it("delivers to a subscriber when the broadcast comes from another sender", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToLocalDocsChanges(handler);

    // Simulate "another tab" by posting raw on the same channel name
    // — that channel has a different sender id by construction.
    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();

    // BroadcastChannel delivery is asynchronous; yield once.
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("ignores broadcasts originated by the same tab", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToLocalDocsChanges(handler);

    broadcastLocalDocsChanged();
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToLocalDocsChanges(handler);
    unsubscribe();

    const externalChannel = new BroadcastChannel("anipres:local-docs");
    externalChannel.postMessage({ senderId: "other-tab" });
    externalChannel.close();
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });
});
