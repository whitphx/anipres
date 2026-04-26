import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  assetNameSchema,
  documentAssetUploadFieldsSchema,
  documentAssetUploadFileSchema,
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

  it("rejects an empty title", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "   \t\n",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a single non-whitespace character title", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "a",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 256-char whitespace-only title (regex wins over maxLength)", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: " ".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a title with leading and trailing whitespace", () => {
    const result = v.safeParse(documentMetadataSchema, {
      ...validMetadata,
      title: "  hello  ",
    });
    expect(result.success).toBe(true);
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

describe("assetNameSchema", () => {
  it("accepts a UUID with no extension", () => {
    const result = v.safeParse(
      assetNameSchema,
      "8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d",
    );
    expect(result.success).toBe(true);
  });

  it("accepts a UUID with an extension", () => {
    const result = v.safeParse(
      assetNameSchema,
      "8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d.png",
    );
    expect(result.success).toBe(true);
  });

  it("rejects a path-traversal attempt", () => {
    const result = v.safeParse(assetNameSchema, "../etc/passwd");
    expect(result.success).toBe(false);
  });

  it("rejects an arbitrary string", () => {
    const result = v.safeParse(assetNameSchema, "not-a-uuid.png");
    expect(result.success).toBe(false);
  });
});

describe("documentAssetUploadFieldsSchema", () => {
  it("accepts a body with a File field", () => {
    const result = v.safeParse(documentAssetUploadFieldsSchema, {
      file: new File(["hello"], "x.txt", { type: "text/plain" }),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing file field", () => {
    const result = v.safeParse(documentAssetUploadFieldsSchema, {});
    expect(result.success).toBe(false);
  });

  it("rejects a non-File value in the file field", () => {
    const result = v.safeParse(documentAssetUploadFieldsSchema, {
      file: "not a file",
    });
    expect(result.success).toBe(false);
  });
});

describe("documentAssetUploadFileSchema", () => {
  it("accepts a small image with an allowed MIME type", () => {
    const file = new File(["x"], "tiny.png", { type: "image/png" });
    const result = v.safeParse(documentAssetUploadFileSchema, file);
    expect(result.success).toBe(true);
  });

  it("rejects an unsupported MIME type", () => {
    const file = new File(["x"], "evil.exe", {
      type: "application/octet-stream",
    });
    const result = v.safeParse(documentAssetUploadFileSchema, file);
    expect(result.success).toBe(false);
  });

  it("rejects a file exceeding MAX_ASSET_SIZE", () => {
    // Construct a file that reports size > 10 MB without actually
    // allocating the bytes by passing a typed-array view.
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const file = new File([oversized], "big.png", { type: "image/png" });
    const result = v.safeParse(documentAssetUploadFileSchema, file);
    expect(result.success).toBe(false);
  });
});
