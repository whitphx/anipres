import { describe, expect, it } from "vitest";
import type { TLStoreSnapshot } from "tldraw";
import { isStaleRecoveryEntry, type SyncCacheEntry } from "./idb-sync-cache";

const snapshot = {
  store: {
    doc: { id: "doc" },
  },
  schema: {},
} as unknown as TLStoreSnapshot;

function createEntry(updatedAt?: number): SyncCacheEntry {
  return {
    snapshot,
    snapshotVersion: 1,
    updatedAt,
  };
}

describe("isStaleRecoveryEntry", () => {
  it("treats entries without timestamps as stale", () => {
    expect(isStaleRecoveryEntry(createEntry(undefined), Date.now())).toBe(true);
  });

  it("keeps recent entries alive", () => {
    const now = Date.now();
    expect(isStaleRecoveryEntry(createEntry(now - 60_000), now)).toBe(false);
  });

  it("expires old recovery entries", () => {
    const now = Date.now();
    expect(
      isStaleRecoveryEntry(createEntry(now - 8 * 24 * 60 * 60 * 1000), now),
    ).toBe(true);
  });
});
