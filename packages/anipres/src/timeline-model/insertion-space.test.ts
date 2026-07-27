import { describe, it, expect } from "vitest";
import { makeInsertionSpace } from "./insertion-space";

describe("makeInsertionSpace", () => {
  it("inserts between distinct keys without touching neighbors", () => {
    const result = makeInsertionSpace(
      [
        { id: "a", key: "a1" },
        { id: "b", key: "a5" },
      ],
      1,
    );
    expect(result.updates).toEqual([]);
    expect(result.insertedKey > "a1" && result.insertedKey < "a5").toBe(true);
  });

  it("inserts at the ends", () => {
    const items = [{ id: "a", key: "a1" }];
    const before = makeInsertionSpace(items, 0);
    expect(before.updates).toEqual([]);
    expect(before.insertedKey < "a1").toBe(true);
    const after = makeInsertionSpace(items, 1);
    expect(after.updates).toEqual([]);
    expect(after.insertedKey > "a1").toBe(true);
  });

  it("re-keys only the local equal-key run, preserving order", () => {
    const items = [
      { id: "a", key: "a1" },
      { id: "b", key: "a2" },
      { id: "c", key: "a2" },
      { id: "d", key: "a7" },
    ];
    const result = makeInsertionSpace(items, 2); // between b and c
    const keyOf = new Map(result.updates.map((u) => [u.id, u.key]));
    const finalKeys = [
      keyOf.get("a") ?? "a1",
      keyOf.get("b") ?? "a2",
      result.insertedKey,
      keyOf.get("c") ?? "a2",
      keyOf.get("d") ?? "a7",
    ];
    for (let i = 1; i < finalKeys.length; i++) {
      expect(finalKeys[i - 1] < finalKeys[i]).toBe(true);
    }
    // Only run members may be re-keyed — never a or d.
    expect(keyOf.has("a")).toBe(false);
    expect(keyOf.has("d")).toBe(false);
    // Run bounds respected.
    expect(finalKeys[1] > "a1").toBe(true);
    expect(finalKeys[3] < "a7").toBe(true);
  });

  it("handles a run at the array boundary", () => {
    const items = [
      { id: "a", key: "a2" },
      { id: "b", key: "a2" },
    ];
    const result = makeInsertionSpace(items, 1);
    const keyOf = new Map(result.updates.map((u) => [u.id, u.key]));
    const finalKeys = [
      keyOf.get("a") ?? "a2",
      result.insertedKey,
      keyOf.get("b") ?? "a2",
    ];
    for (let i = 1; i < finalKeys.length; i++) {
      expect(finalKeys[i - 1] < finalKeys[i]).toBe(true);
    }
  });

  it("is deterministic, so concurrent normalizations of the same run converge", () => {
    const items = [
      { id: "a", key: "a2" },
      { id: "b", key: "a2" },
      { id: "c", key: "a2" },
    ];
    const r1 = makeInsertionSpace(items, 2);
    const r2 = makeInsertionSpace(items, 2);
    expect(r1).toEqual(r2);
  });

  it("remains total after record-level merging re-collides keys", () => {
    // Two clients normalized overlapping runs; LWW merging produced a new
    // equal-key pair. That must degrade to an ordinary collision run.
    const merged = [
      { id: "a", key: "a1" },
      { id: "b", key: "a3" }, // client 1's re-key
      { id: "c", key: "a3" }, // client 2's re-key collided
    ];
    const result = makeInsertionSpace(merged, 2);
    const keyOf = new Map(result.updates.map((u) => [u.id, u.key]));
    const finalKeys = [
      keyOf.get("a") ?? "a1",
      keyOf.get("b") ?? "a3",
      result.insertedKey,
      keyOf.get("c") ?? "a3",
    ];
    for (let i = 1; i < finalKeys.length; i++) {
      expect(finalKeys[i - 1] < finalKeys[i]).toBe(true);
    }
  });

  it("throws only on out-of-range insertion index", () => {
    expect(() => makeInsertionSpace([], 1)).toThrow();
    expect(() => makeInsertionSpace([], 0)).not.toThrow();
  });
});
