import { describe, it, expect } from "vitest";
import {
  COPY_PROVENANCE_KEY,
  attachCopyProvenance,
  classifyRemapOperation,
  readCopyProvenance,
  stripCopyProvenance,
} from "./provenance";
import type { AnipresCopyProvenance } from "./provenance";

// A TLContent-shaped payload. The concrete ids matter for the
// identical-snapshot scenario below: classification must be independent
// of ALL of them.
function makeContent() {
  return {
    shapes: [
      {
        id: "shape:a",
        meta: {
          frame: {
            v: 2,
            id: "f1",
            type: "cue",
            trackId: "T",
            stepId: "s1",
            stepOrderKey: "a1",
            action: { type: "shapeAnimation" },
          },
        },
      },
    ],
    rootShapeIds: ["shape:a"],
    assets: [{ id: "asset:x" }],
    schema: { schemaVersion: 2 },
  };
}

/**
 * Mirrors the pinned tldraw version's clipboard serialization (v3
 * format): the copy path spreads the content's non-asset properties into
 * a stringified payload (`const { assets, ...otherData } = content`) and
 * the paste path reconstructs `{ assets, ...otherData }`. Extra
 * top-level properties — the provenance — ride along both ways.
 */
function clipboardRoundTrip<T extends object>(content: T): T {
  const { assets, ...otherData } = content as T & { assets?: unknown };
  const stringified = JSON.stringify({
    assets: assets ?? [],
    otherCompressed: JSON.stringify(otherData),
  });
  const parsed = JSON.parse(stringified);
  return { assets: parsed.assets, ...JSON.parse(parsed.otherCompressed) };
}

/** Pastes stamped content and classifies it against a local instance. */
function classifyPaste(input: {
  copiedWithToken: string | null;
  localDocumentToken: string;
  sourceShapeIds?: readonly string[];
  existingShapeIds?: readonly string[];
}) {
  const content =
    input.copiedWithToken != null
      ? attachCopyProvenance(makeContent(), input.copiedWithToken)
      : makeContent();
  const pasted = clipboardRoundTrip(content);
  const existingSet = new Set(input.existingShapeIds ?? []);
  return classifyRemapOperation({
    provenance: readCopyProvenance(pasted),
    localDocumentToken: input.localDocumentToken,
    sourceShapeIds: input.sourceShapeIds ?? ["shape:a"],
    shapeExistsInDocument: (shapeId) => existingSet.has(shapeId),
  });
}

describe("copy provenance — serialization round trip", () => {
  it("survives the tldraw clipboard format and reads back intact", () => {
    const stamped = attachCopyProvenance(makeContent(), "token-1");
    const pasted = clipboardRoundTrip(stamped);
    expect(readCopyProvenance(pasted)).toEqual({
      sourceDocumentToken: "token-1",
    });
  });

  it("strips the private property so it is never persisted", () => {
    const stamped = attachCopyProvenance(makeContent(), "token-1");
    const stripped = stripCopyProvenance(clipboardRoundTrip(stamped));
    expect(COPY_PROVENANCE_KEY in stripped).toBe(false);
    // Everything else is untouched.
    expect(stripped).toEqual(clipboardRoundTrip(makeContent()));
    // Content without the property passes through by reference.
    const plain = makeContent();
    expect(stripCopyProvenance(plain)).toBe(plain);
  });
});

describe("classifyRemapOperation (provenance + source-shape existence)", () => {
  it("classifies same-document copy/paste (sources still present) as duplicate", () => {
    expect(
      classifyPaste({
        copiedWithToken: "doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("duplicate");
  });

  it("classifies same-document cut+paste (sources removed) as move", () => {
    // tldraw's cut stamps the content at copy time and then deletes the
    // shapes: token matches, no source shape exists → the same logical
    // animation objects are RETURNING, not being copied.
    expect(
      classifyPaste({
        copiedWithToken: "doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: [],
      }),
    ).toBe("move");
  });

  it("classifies undo-cut-then-paste (sources restored) as duplicate", () => {
    // The undo restored the originals, which own their identities again;
    // the paste must be an independent copy, never a rejoin.
    expect(
      classifyPaste({
        copiedWithToken: "doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("duplicate");
  });

  it("classifies mixed source presence conservatively as external-paste", () => {
    // Partial undo/deletion between cut and paste: neither duplication
    // nor move semantics can be applied partially without risking wrong
    // joins or misplacement — collision-driven external-paste rules are
    // the safe fallback (no step/track joining, no placement).
    expect(
      classifyPaste({
        copiedWithToken: "doc-token",
        localDocumentToken: "doc-token",
        sourceShapeIds: ["shape:a", "shape:b"],
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("external-paste");
  });

  it("classifies a paste from another document as external-paste", () => {
    expect(
      classifyPaste({
        copiedWithToken: "other-doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: [],
      }),
    ).toBe("external-paste");
  });

  it("classifies an identical-snapshot sibling paste as external-paste", () => {
    // Two documents created from the same snapshot share EVERY id —
    // shape, frame, step, and track — so the source shape ids DO resolve
    // locally. Only the token can (and does) tell the flows apart.
    expect(JSON.stringify(makeContent())).toBe(JSON.stringify(makeContent()));
    expect(
      classifyPaste({
        copiedWithToken: "sibling-token",
        localDocumentToken: "doc-token",
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("external-paste");
    expect(
      classifyPaste({
        copiedWithToken: "doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("duplicate");
  });

  it("classifies cross-document cut+paste as external-paste (unchanged collision rules)", () => {
    // The source shapes never existed here; the differing token decides.
    expect(
      classifyPaste({
        copiedWithToken: "other-doc-token",
        localDocumentToken: "doc-token",
        existingShapeIds: [],
      }),
    ).toBe("external-paste");
  });

  it("classifies content without provenance as external-paste (safe default)", () => {
    // Older anipres versions, other tldraw apps, or hand-crafted
    // payloads carry no token.
    expect(readCopyProvenance(clipboardRoundTrip(makeContent()))).toBeNull();
    expect(
      classifyPaste({
        copiedWithToken: null,
        localDocumentToken: "doc-token",
        existingShapeIds: ["shape:a"],
      }),
    ).toBe("external-paste");
    expect(readCopyProvenance(null)).toBeNull();
    expect(
      readCopyProvenance({ [COPY_PROVENANCE_KEY]: "not-an-object" }),
    ).toBeNull();
  });

  it("classifies empty content as external-paste (a no-op either way)", () => {
    const provenance: AnipresCopyProvenance = {
      sourceDocumentToken: "doc-token",
    };
    expect(
      classifyRemapOperation({
        provenance,
        localDocumentToken: "doc-token",
        sourceShapeIds: [],
        shapeExistsInDocument: () => true,
      }),
    ).toBe("external-paste");
  });
});

describe("shapes added to a payload on the caller's behalf", () => {
  const TOKEN = "doc-token";

  it("classifies a cut and paste by what the copy asked for", () => {
    // Copying a video pulls in its event markers. A cut deletes the
    // carrier that was selected; in a shared document the markers stay.
    const provenance = {
      sourceDocumentToken: TOKEN,
      requestedShapeIds: ["shape:video"],
    };
    expect(
      classifyRemapOperation({
        provenance,
        localDocumentToken: TOKEN,
        sourceShapeIds: ["shape:video", "shape:marker"],
        shapeExistsInDocument: (shapeId) => shapeId === "shape:marker",
      }),
    ).toBe("move");
  });

  it("still calls a copy and paste a duplicate", () => {
    const provenance = {
      sourceDocumentToken: TOKEN,
      requestedShapeIds: ["shape:video"],
    };
    expect(
      classifyRemapOperation({
        provenance,
        localDocumentToken: TOKEN,
        sourceShapeIds: ["shape:video", "shape:marker"],
        shapeExistsInDocument: () => true,
      }),
    ).toBe("duplicate");
  });

  it("falls back to the payload's ids when the copy recorded none", () => {
    expect(
      classifyRemapOperation({
        provenance: { sourceDocumentToken: TOKEN },
        localDocumentToken: TOKEN,
        sourceShapeIds: ["shape:video"],
        shapeExistsInDocument: () => false,
      }),
    ).toBe("move");
  });

  it("round-trips the requested ids through a payload", () => {
    const content = attachCopyProvenance({ shapes: [] }, TOKEN, [
      "shape:video",
    ]);
    expect(readCopyProvenance(content)?.requestedShapeIds).toEqual([
      "shape:video",
    ]);
    // A payload from a build that did not record them reads as absent
    // rather than as an empty selection.
    expect(
      readCopyProvenance({
        anipresCopyProvenance: { sourceDocumentToken: TOKEN },
      })?.requestedShapeIds,
    ).toBeUndefined();
  });
});
