import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  documentListQuerySchema,
  documentUpsertSchema,
  snapshotPushBodySchema,
} from "./documents";

describe("documentListQuerySchema", () => {
  it("accepts a positive integer workspace_id", () => {
    const result = v.safeParse(documentListQuerySchema, {
      workspace_id: "7",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.workspace_id).toBe(7);
    }
  });

  it("rejects a missing workspace_id", () => {
    const result = v.safeParse(documentListQuerySchema, {});
    expect(result.success).toBe(false);
  });

  it("rejects zero", () => {
    const result = v.safeParse(documentListQuerySchema, { workspace_id: "0" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric workspace_id", () => {
    const result = v.safeParse(documentListQuerySchema, {
      workspace_id: "personal",
    });
    expect(result.success).toBe(false);
  });
});

describe("documentUpsertSchema", () => {
  // The unified PUT-as-upsert body covers both create and update.
  // `id` is in the URL path, not the body. workspace_id, title, and
  // sort_order are all required; created_at is an optional override
  // (used only on the insert path server-side).
  const validBody = {
    workspace_id: "1",
    title: "My Document",
    sort_order: "a0",
  };

  it("accepts a minimal body", () => {
    const result = v.safeParse(documentUpsertSchema, validBody);
    expect(result.success).toBe(true);
  });

  it("accepts a body with the optional created_at override", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      created_at: 1700000000000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing workspace_id", () => {
    const result = v.safeParse(documentUpsertSchema, {
      title: "x",
      sort_order: "a0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-numeric workspace_id", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      workspace_id: "default",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = v.safeParse(documentUpsertSchema, {
      workspace_id: "1",
      sort_order: "a0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      title: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      title: "   \t\n",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title longer than 256 characters", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      title: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a title with a null byte", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      title: "hello\u0000world",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sort_order", () => {
    const result = v.safeParse(documentUpsertSchema, {
      workspace_id: "1",
      title: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty sort_order", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      sort_order: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sort_order longer than 256 characters", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      sort_order: "a".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string sort_order", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      sort_order: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer created_at", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      created_at: 1700000000000.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative created_at", () => {
    const result = v.safeParse(documentUpsertSchema, {
      ...validBody,
      created_at: -1,
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
