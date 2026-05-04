import { describe, expect, it, vi } from "vitest";
import { broadcastLogout, subscribeToAuthBroadcasts } from "./auth-broadcast";

describe("auth broadcast", () => {
  it("delivers a logout message from another sender", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);

    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();

    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "logout" });
    unsubscribe();
  });

  it("ignores broadcasts originated by the same tab", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);

    broadcastLogout();
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("removes the listener on unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToAuthBroadcasts(handler);
    unsubscribe();

    const externalChannel = new BroadcastChannel("anipres:auth");
    externalChannel.postMessage({ type: "logout", senderId: "other-tab" });
    externalChannel.close();
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).not.toHaveBeenCalled();
  });
});
