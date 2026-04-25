import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  documentIdParamSchema,
  documentMetadataSchema,
  snapshotPushBodySchema,
} from "./schemas";

describe("documentIdParamSchema", () => {
  it("accepts a UUID id", () => {
    const result = v.safeParse(documentIdParamSchema, {
      id: "8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID id", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id", () => {
    const result = v.safeParse(documentIdParamSchema, {});
    expect(result.success).toBe(false);
  });
});

describe("documentMetadataSchema", () => {
  const validMetadata = {
    title: "My Document",
    order: 1,
    created_at: 1700000000000,
    updated_at: 1700000000001,
  };

  it("accepts well-formed metadata", () => {
    const result = v.safeParse(documentMetadataSchema, validMetadata);
    expect(result.success).toBe(true);
  });

  it("rejects a title longer than 256 characters", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a title at the 256-character limit", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "x".repeat(256),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a title with a null byte", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "hello\u0000world",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-finite order (NaN)", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      order: Number.NaN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-finite order (Infinity)", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      order: Number.POSITIVE_INFINITY,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an order below the lower bound", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      order: -1e10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an order above the upper bound", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      order: 1e10,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a fractional order (used by reorder logic)", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      order: 1.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative timestamp", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      created_at: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer timestamp", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      updated_at: 1700000000000.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects NaN timestamps", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      created_at: Number.NaN,
    });
    expect(result.success).toBe(false);
  });
});

describe("snapshotPushBodySchema", () => {
  const validBody = {
    snapshot: { "shape:abc": { id: "shape:abc", typeName: "shape" } },
    expectedSnapshotVersion: 0,
  };

  it("accepts a well-formed body", () => {
    const result = v.safeParse(snapshotPushBodySchema, validBody);
    expect(result.success).toBe(true);
  });

  it("accepts an empty snapshot record", () => {
    const result = v.safeParse(snapshotPushBodySchema, {
      ...validBody,
      snapshot: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative expectedSnapshotVersion", () => {
    const result = v.safeParse(snapshotPushBodySchema, {
      ...validBody,
      expectedSnapshotVersion: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer expectedSnapshotVersion", () => {
    const result = v.safeParse(snapshotPushBodySchema, {
      ...validBody,
      expectedSnapshotVersion: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a NaN expectedSnapshotVersion", () => {
    const result = v.safeParse(snapshotPushBodySchema, {
      ...validBody,
      expectedSnapshotVersion: Number.NaN,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object snapshot", () => {
    const result = v.safeParse(snapshotPushBodySchema, {
      snapshot: "not an object",
      expectedSnapshotVersion: 0,
    });
    expect(result.success).toBe(false);
  });
});
