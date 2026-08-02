import { describe, expect, it } from "vitest";
import {
  compareOrderKeys,
  orderKeyBetween,
  orderKeysBetween,
  type OrderKey,
} from "./order-key";
import { parseFrameMeta, frameToMetaJson } from "./parse";
import type { CueFrame } from "./types";

function isSorted(keys: OrderKey[]): boolean {
  return keys.every((k, i) => i === 0 || compareOrderKeys(keys[i - 1], k) < 0);
}

describe("orderKeyBetween", () => {
  it("matches the upstream fractional-indexing test vectors", () => {
    // From rocicorp/fractional-indexing's own test file (default digits):
    // https://github.com/rocicorp/fractional-indexing/blob/main/src/test.js
    const vectors: [OrderKey | null, OrderKey | null, OrderKey][] = [
      [null, null, "a0"],
      [null, "a0", "Zz"],
      [null, "Zz", "Zy"],
      ["a0", null, "a1"],
      ["a1", null, "a2"],
      ["a0", "a1", "a0V"],
      ["a1", "a2", "a1V"],
      ["a0V", "a1", "a0l"],
      ["Zz", "a0", "ZzV"],
      ["Zz", "a1", "a0"],
      [null, "Y00", "Xzzz"],
      ["bzz", null, "c000"],
      ["a0", "a0V", "a0G"],
      ["a0", "a0G", "a08"],
      ["b125", "b129", "b127"],
      ["a0", "a1V", "a1"],
      ["Zz", "a01", "a0"],
      [null, "a0V", "a0"],
      [null, "b999", "b99"],
    ];
    for (const [a, b, expected] of vectors) {
      expect(orderKeyBetween(a, b)).toBe(expected);
    }
  });

  it("inserts at the beginning, middle, and end in order", () => {
    const first = orderKeyBetween(null, null);
    const end = orderKeyBetween(first, null);
    const beginning = orderKeyBetween(null, first);
    const middle = orderKeyBetween(first, end);
    expect(isSorted([beginning, first, middle, end])).toBe(true);
  });

  it("is deterministic, and iterated insertion between the same neighbors stays ordered", () => {
    const a = orderKeyBetween(null, null);
    const b = orderKeyBetween(a, null);
    // Same inputs, same key — no jitter.
    expect(orderKeyBetween(a, b)).toBe(orderKeyBetween(a, b));

    // Repeatedly inserting "right after a" nests keys without ever
    // colliding with the bounds or each other.
    const keys: OrderKey[] = [];
    let upper = b;
    for (let i = 0; i < 20; i++) {
      upper = orderKeyBetween(a, upper);
      keys.push(upper);
    }
    expect(new Set(keys).size).toBe(20);
    expect(isSorted([a, ...keys.slice().reverse(), b])).toBe(true);
  });
});

describe("orderKeysBetween", () => {
  it("generates n strictly ascending keys inside the bounds", () => {
    const a = "a0";
    const b = "a1";
    const keys = orderKeysBetween(a, b, 8);
    expect(keys).toHaveLength(8);
    expect(isSorted([a, ...keys, b])).toBe(true);
  });

  it("handles open ends", () => {
    expect(orderKeysBetween(null, null, 3)).toEqual(["a0", "a1", "a2"]);
    expect(isSorted(orderKeysBetween("a5", null, 4))).toBe(true);
    expect(isSorted(orderKeysBetween(null, "a0", 4))).toBe(true);
  });
});

describe("compareOrderKeys", () => {
  it("compares by code units, not locale collation", () => {
    // Keys generated before the first item are capital-prefixed ("Zz" <
    // "a0" by code units) — locale-aware comparison would invert them.
    expect(compareOrderKeys("Zz", "a0")).toBeLessThan(0);
    expect(compareOrderKeys("a0", "Zz")).toBeGreaterThan(0);
    expect(compareOrderKeys("a0", "a0")).toBe(0);
  });

  it("sorting equal keys stays deterministic with an id tie-break", () => {
    // Equal keys are legal (identity lives in ids); every consumer sort
    // tie-breaks on the object's stable unique id. Any input permutation
    // must produce the same result.
    const items = [
      { id: "c", key: "a1" },
      { id: "a", key: "a1" },
      { id: "b", key: "a0" },
      { id: "d", key: "a1" },
    ];
    const sortByKeyThenId = (list: typeof items) =>
      [...list].sort(
        (x, y) => compareOrderKeys(x.key, y.key) || (x.id < y.id ? -1 : 1),
      );
    const expected = sortByKeyThenId(items).map((i) => i.id);
    expect(expected).toEqual(["b", "a", "c", "d"]);
    // Rotate through a few permutations.
    for (let i = 0; i < items.length; i++) {
      const rotated = [...items.slice(i), ...items.slice(0, i)];
      expect(sortByKeyThenId(rotated).map((x) => x.id)).toEqual(expected);
    }
  });
});

describe("key serialization", () => {
  it("keys survive a JSON round trip byte-for-byte, preserving order", () => {
    const keys = orderKeysBetween(null, null, 5).flatMap((k, i, all) => [
      k,
      orderKeyBetween(k, all[i + 1] ?? null),
    ]);
    const restored = JSON.parse(JSON.stringify(keys)) as OrderKey[];
    expect(restored).toEqual(keys);
    expect(isSorted([...new Set(restored)].sort(compareOrderKeys))).toBe(true);
  });

  it("keys survive the frame meta round trip", () => {
    const frame: CueFrame = {
      v: 2,
      id: "f1",
      type: "cue",
      trackId: "t1",
      stepId: "s1",
      stepOrderKey: orderKeyBetween("Zz", "a0"),
      action: { type: "shapeAnimation" },
    };
    const parsed = parseFrameMeta(
      JSON.parse(JSON.stringify(frameToMetaJson(frame))),
    );
    expect(parsed.kind).toBe("v2");
    if (parsed.kind === "v2" && parsed.frame.type === "cue") {
      expect(parsed.frame.stepOrderKey).toBe(frame.stepOrderKey);
    }
  });
});
