import { describe, expect, it } from "vitest";
import {
  documentAssetUploadFieldsSchema,
  documentAssetUploadFileSchema,
} from "./document-assets";

describe("documentAssetUploadFieldsSchema", () => {
  it("accepts a body with a File field", () => {
    const result = documentAssetUploadFieldsSchema.safeParse({
      file: new File(["hello"], "x.txt", { type: "text/plain" }),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing file field", () => {
    const result = documentAssetUploadFieldsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a non-File value in the file field", () => {
    const result = documentAssetUploadFieldsSchema.safeParse({
      file: "not a file",
    });
    expect(result.success).toBe(false);
  });
});

describe("documentAssetUploadFileSchema", () => {
  it("accepts a small image with an allowed MIME type", () => {
    const file = new File(["x"], "tiny.png", { type: "image/png" });
    const result = documentAssetUploadFileSchema.safeParse(file);
    expect(result.success).toBe(true);
  });

  it("rejects an unsupported MIME type", () => {
    const file = new File(["x"], "evil.exe", {
      type: "application/octet-stream",
    });
    const result = documentAssetUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
  });

  it("rejects a file exceeding MAX_ASSET_SIZE", () => {
    // Construct a file that reports size > MAX_ASSET_SIZE without
    // actually allocating the bytes by passing a typed-array view.
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const file = new File([oversized], "big.png", { type: "image/png" });
    const result = documentAssetUploadFileSchema.safeParse(file);
    expect(result.success).toBe(false);
  });
});
