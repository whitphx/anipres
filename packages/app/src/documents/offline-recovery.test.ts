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
        cacheEntry: undefined,
        recoveryEntry: undefined,
        isOnline: true,
      }),
    ).toEqual({ type: "synced" });
  });

  it("starts unavailable offline without a cache entry", () => {
    expect(
      resolveStartupState({
        cacheEntry: undefined,
        recoveryEntry: undefined,
        isOnline: false,
      }),
    ).toEqual({ type: "unavailable" });
  });

  it("ignores the shared cache while online without a recovery entry", () => {
    const snapshot = createSnapshot("doc");

    expect(
      resolveStartupState({
        cacheEntry: {
          snapshot,
          snapshotVersion: 3,
        },
        recoveryEntry: undefined,
        isOnline: true,
      }),
    ).toEqual({ type: "synced" });
  });

  it("restores a recovery entry while online", () => {
    const snapshot = createSnapshot("doc");
    const reconnectSnapshot = createSnapshot("doc-next");

    expect(
      resolveStartupState({
        cacheEntry: undefined,
        recoveryEntry: {
          snapshot,
          snapshotVersion: 3,
          recovery: createRecoveryState({
            baselineSnapshot: snapshot,
            reconnectSnapshot,
            hasPendingOfflineChanges: true,
          }),
        },
        isOnline: true,
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
        cacheEntry: {
          snapshot,
          snapshotVersion: 5,
        },
        recoveryEntry: undefined,
        isOnline: false,
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

  it("prefers the recovery entry over the shared cache offline", () => {
    const cacheSnapshot = createSnapshot("cache");
    const recoverySnapshot = createSnapshot("recovery");

    expect(
      resolveStartupState({
        cacheEntry: {
          snapshot: cacheSnapshot,
          snapshotVersion: 3,
        },
        recoveryEntry: {
          snapshot: recoverySnapshot,
          snapshotVersion: 4,
          recovery: createRecoveryState({
            baselineSnapshot: cacheSnapshot,
            reconnectSnapshot: recoverySnapshot,
            hasPendingOfflineChanges: true,
          }),
        },
        isOnline: false,
      }),
    ).toEqual({
      type: "offline",
      snapshot: recoverySnapshot,
      recovery: {
        baselineSnapshot: cacheSnapshot,
        reconnectSnapshot: recoverySnapshot,
        hasPendingOfflineChanges: true,
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
