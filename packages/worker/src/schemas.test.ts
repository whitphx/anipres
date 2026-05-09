import { describe, expect, it } from "vitest";
import { assetNameSchema, documentIdParamSchema } from "./schemas";

describe("documentIdParamSchema", () => {
  // Canonical UUID v7 example. The schema doesn't enforce v7
  // specifically — any well-formed UUID passes the regex — but the
  // app side always generates v7. Lower-case hex is the canonical
  // form per RFC 9562; mixed case is also accepted.
  const validUuid = "0190e7c0-9c52-7000-9d4f-1a2b3c4d5e6f";

  it("accepts a canonical UUID", () => {
    const result = documentIdParamSchema.safeParse({ id: validUuid });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(validUuid);
    }
  });

  it("accepts mixed-case hex", () => {
    const result = documentIdParamSchema.safeParse({
      id: "0190E7C0-9C52-7000-9D4F-1A2B3C4D5E6F",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing dash", () => {
    const result = documentIdParamSchema.safeParse({
      id: "0190e7c09c52-7000-9d4f-1a2b3c4d5e6f",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-hex character", () => {
    const result = documentIdParamSchema.safeParse({
      id: "0190e7c0-9c52-7000-9d4z-1a2b3c4d5e6f",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short id", () => {
    const result = documentIdParamSchema.safeParse({
      id: "0190e7c0-9c52-7000-9d4f",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decimal integer (the previous shape)", () => {
    const result = documentIdParamSchema.safeParse({ id: "42" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id", () => {
    const result = documentIdParamSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("assetNameSchema", () => {
  it("accepts a UUID with no extension", () => {
    const result = assetNameSchema.safeParse("8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d",
    );
    expect(result.success).toBe(true);
  });

  it("accepts a UUID with an extension", () => {
    const result = assetNameSchema.safeParse("8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d.png",
    );
    expect(result.success).toBe(true);
  });

  it("rejects a path-traversal attempt", () => {
    const result = assetNameSchema.safeParse("../etc/passwd");
    expect(result.success).toBe(false);
  });

  it("rejects an arbitrary string", () => {
    const result = assetNameSchema.safeParse("not-a-uuid.png");
    expect(result.success).toBe(false);
  });
});
