import { describe, expect, it } from "vitest";
import type { TLStoreSnapshot } from "tldraw";
import {
  createRecoveryState,
  resolveStartupState,
  shouldSkipReconnect,
} from "./offline-recovery";

function createSnapshot(id: string): TLStoreSnapshot {
  return {
    store: {
      [id]: { id },
    },
    schema: {},
  } as unknown as TLStoreSnapshot;
}

describe("resolveStartupState", () => {
  it("starts synced online without a cache entry", () => {
    expect(
      resolveStartupState({
        entry: undefined,
        isOnline: true,
        currentSessionId: "tab-a",
      }),
    ).toEqual({ type: "synced" });
  });

  it("starts unavailable offline without a cache entry", () => {
    expect(
      resolveStartupState({
        entry: undefined,
        isOnline: false,
        currentSessionId: "tab-a",
      }),
    ).toEqual({ type: "unavailable" });
  });

  it("does not restore another tab's recovery state while online", () => {
    const snapshot = createSnapshot("doc");

    expect(
      resolveStartupState({
        entry: {
          snapshot,
          snapshotVersion: 3,
          recovery: createRecoveryState({
            baselineSnapshot: snapshot,
            reconnectSnapshot: snapshot,
            hasPendingOfflineChanges: true,
            ownerSessionId: "tab-a",
          }),
        },
        isOnline: true,
        currentSessionId: "tab-b",
      }),
    ).toEqual({ type: "synced" });
  });

  it("restores this tab's recovery state while online", () => {
    const snapshot = createSnapshot("doc");
    const reconnectSnapshot = createSnapshot("doc-next");

    expect(
      resolveStartupState({
        entry: {
          snapshot,
          snapshotVersion: 3,
          recovery: createRecoveryState({
            baselineSnapshot: snapshot,
            reconnectSnapshot,
            hasPendingOfflineChanges: true,
            ownerSessionId: "tab-a",
          }),
        },
        isOnline: true,
        currentSessionId: "tab-a",
      }),
    ).toEqual({
      type: "offline",
      snapshot,
      recovery: {
        baselineSnapshot: snapshot,
        reconnectSnapshot,
        hasPendingOfflineChanges: true,
      },
      shouldAutoReconnect: true,
    });
  });

  it("derives offline recovery defaults from the cached snapshot", () => {
    const snapshot = createSnapshot("doc");

    expect(
      resolveStartupState({
        entry: {
          snapshot,
          snapshotVersion: 5,
        },
        isOnline: false,
        currentSessionId: "tab-a",
      }),
    ).toEqual({
      type: "offline",
      snapshot,
      recovery: {
        baselineSnapshot: snapshot,
        reconnectSnapshot: snapshot,
        hasPendingOfflineChanges: false,
      },
      shouldAutoReconnect: false,
    });
  });
});

describe("shouldSkipReconnect", () => {
  it("skips when the offline snapshot still matches the baseline", () => {
    const snapshot = createSnapshot("doc");

    expect(
      shouldSkipReconnect({
        snapshot,
        recovery: {
          baselineSnapshot: snapshot,
          reconnectSnapshot: createSnapshot("doc-next"),
          hasPendingOfflineChanges: true,
        },
      }),
    ).toBe(true);
  });

  it("skips when the snapshot only reflects the reconnect baseline", () => {
    const snapshot = createSnapshot("doc");

    expect(
      shouldSkipReconnect({
        snapshot,
        recovery: {
          baselineSnapshot: createSnapshot("doc-old"),
          reconnectSnapshot: snapshot,
          hasPendingOfflineChanges: false,
        },
      }),
    ).toBe(true);
  });

  it("does not skip when pending local changes still exist", () => {
    const snapshot = createSnapshot("doc");

    expect(
      shouldSkipReconnect({
        snapshot,
        recovery: {
          baselineSnapshot: createSnapshot("doc-old"),
          reconnectSnapshot: snapshot,
          hasPendingOfflineChanges: true,
        },
      }),
    ).toBe(false);
  });
});
