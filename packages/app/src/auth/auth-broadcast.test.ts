import { describe, expect, it, vi } from "vitest";
import { broadcastLogout, subscribeToAuthBroadcasts } from "./auth-broadcast";

// The BroadcastChannel here is Node's built-in (happy-dom provides
// none), and it delivers across instances asynchronously with no
// guarantee the message lands within any fixed number of event-loop
// turns, so a `setTimeout(0)` wait loses the race on slow runners.
// Positive assertions poll with `vi.waitFor`. Negative assertions
// synchronize on a control channel that receives every message
// unfiltered: once the control has seen the message, the subject
// handler has had its delivery chance too.
function nextBroadcast(): Promise<unknown> {
  return new Promise((resolve) => {
    const control = new BroadcastChannel("anipres:auth");
    control.onmessage = (event: MessageEvent) => {
      control.close();
      resolve(event.data);
    };
  });
}

describe("auth broadcast", () => {
  it("delivers a logout message from another sender", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);

    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "logout" });
    unsubscribe();
  });

  it("ignores broadcasts originated by the same tab", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);

    const delivered = nextBroadcast();
    broadcastLogout();
    await delivered;
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);
    unsubscribe();

    const delivered = nextBroadcast();
    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();
    await delivered;
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });
});
