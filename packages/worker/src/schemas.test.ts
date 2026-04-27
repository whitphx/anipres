import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  assetNameSchema,
  documentAssetUploadFieldsSchema,
  documentAssetUploadFileSchema,
  documentCreateSchema,
  documentIdParamSchema,
  documentUpdateSchema,
  snapshotPushBodySchema,
} from "./schemas";

describe("documentIdParamSchema", () => {
  it("accepts a positive integer id", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "42" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.id).toBe(42);
    }
  });

  it("accepts id 1", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "1" });
    expect(result.success).toBe(true);
  });

  it("rejects zero", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects leading zeros (non-canonical)", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "01" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative integer", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "-1" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric string", () => {
    const result = v.safeParse(documentIdParamSchema, { id: "not-a-number" });
    expect(result.success).toBe(false);
  });

  it("rejects a UUID (the previous shape)", () => {
    const result = v.safeParse(documentIdParamSchema, {
      id: "8d6f4d3e-3c8f-4a8a-9c9d-1e2f3a4b5c6d",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id", () => {
    const result = v.safeParse(documentIdParamSchema, {});
    expect(result.success).toBe(false);
  });
});

describe("documentCreateSchema", () => {
  const validMinimal = { sort_order: "a0" };

  it("accepts the minimal body (sort_order only)", () => {
    const result = v.safeParse(documentCreateSchema, validMinimal);
    expect(result.success).toBe(true);
  });

  it("accepts a fully-populated body", () => {
    const result = v.safeParse(documentCreateSchema, {
      title: "My Document",
      sort_order: "Z9z",
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty sort_order", () => {
    const result = v.safeParse(documentCreateSchema, { sort_order: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sort_order", () => {
    const result = v.safeParse(documentCreateSchema, {});
    expect(result.success).toBe(false);
  });

  it("rejects a sort_order longer than 256 characters", () => {
    const result = v.safeParse(documentCreateSchema, {
      sort_order: "a".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string sort_order", () => {
    const result = v.safeParse(documentCreateSchema, {
      sort_order: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title longer than 256 characters", () => {
    const result = v.safeParse(documentCreateSchema, {
      ...validMinimal,
      title: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = v.safeParse(documentCreateSchema, {
      ...validMinimal,
      title: "   \t\n",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title with a null byte", () => {
    const result = v.safeParse(documentCreateSchema, {
      ...validMinimal,
      title: "hello\u0000world",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer timestamp", () => {
    const result = v.safeParse(documentCreateSchema, {
      ...validMinimal,
      created_at: 1700000000000.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative timestamp", () => {
    const result = v.safeParse(documentCreateSchema, {
      ...validMinimal,
      created_at: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("documentUpdateSchema", () => {
  const validUpdate = {
    title: "Renamed",
    sort_order: "a0",
  };

  it("accepts well-formed update body", () => {
    const result = v.safeParse(documentUpdateSchema, validUpdate);
    expect(result.success).toBe(true);
  });

  it("rejects a missing title", () => {
    const result = v.safeParse(documentUpdateSchema, {
      sort_order: "a0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sort_order", () => {
    const result = v.safeParse(documentUpdateSchema, {
      title: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = v.safeParse(documentUpdateSchema, {
      ...validUpdate,
      title: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty sort_order", () => {
    const result = v.safeParse(documentUpdateSchema, {
      ...validUpdate,
      sort_order: "",
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
