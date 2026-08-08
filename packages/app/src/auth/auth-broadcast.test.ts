import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastLogout, subscribeToAuthBroadcasts } from "./auth-broadcast";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!();
  }
});

// Node's built-in BroadcastChannel (happy-dom provides none) delivers
// across instances asynchronously, with no bound on how many event-loop
// turns it takes, so no sleep makes "was not called" meaningful. The
// tests wait on a delivery that must come after the one in question
// instead: a receiving channel gets messages in posting order, and a
// single message is fanned out to channels in creation order.
describe("auth broadcast", () => {
  it("delivers a logout message from another sender", async () => {
    const handler = vi.fn();
    cleanups.push(subscribeToAuthBroadcasts(handler));

    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "logout" });
  });

  it("ignores broadcasts originated by the same tab", async () => {
    const handler = vi.fn();
    cleanups.push(subscribeToAuthBroadcasts(handler));

    broadcastLogout();
    // Posted after the same-tab broadcast. Delivery to a channel is
    // FIFO, so the first call the handler ever receives is fixed: if
    // the filter were broken it would be the own-tab message, and the
    // payload assertion below would fail no matter when polling lands.
    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    expect(handler.mock.calls[0][0]).toMatchObject({ senderId: "other-tab" });
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);
    unsubscribe();
    // A second, still-open subscriber proves the message went out.
    const witness = vi.fn();
    cleanups.push(subscribeToAuthBroadcasts(witness));

    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();

    await vi.waitFor(() => expect(witness).toHaveBeenCalledTimes(1));
    expect(handler).not.toHaveBeenCalled();
  });
});
