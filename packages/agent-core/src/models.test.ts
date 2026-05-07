import { describe, expect, it } from "vitest";
import { isValidModelName } from "./models.js";

describe("isValidModelName", () => {
  it("accepts a real model name", () => {
    expect(isValidModelName("claude-sonnet-4-6")).toBe(true);
  });

  it("rejects undefined / empty", () => {
    expect(isValidModelName(undefined)).toBe(false);
    expect(isValidModelName("")).toBe(false);
  });

  it("rejects an unknown name", () => {
    expect(isValidModelName("not-a-model")).toBe(false);
  });

  it("rejects inherited Object.prototype keys", () => {
    // `in` would have returned true for these and bracket-access on the
    // definitions map would have returned a real prototype function,
    // bypassing the downstream `!def` guard.
    for (const key of [
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "toString",
      "valueOf",
    ]) {
      expect(isValidModelName(key)).toBe(false);
    }
  });
});
