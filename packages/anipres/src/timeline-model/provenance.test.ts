import { describe, it, expect } from "vitest";
import {
  COPY_PROVENANCE_KEY,
  attachCopyProvenance,
  classifyRemapOperation,
  readCopyProvenance,
  stripCopyProvenance,
} from "./provenance";

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

describe("classifyRemapOperation (copy-source provenance)", () => {
  it("classifies same-document copy/paste as duplicate (identical shape ids irrelevant)", () => {
    const pasted = clipboardRoundTrip(
      attachCopyProvenance(makeContent(), "doc-token"),
    );
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(pasted),
        localDocumentToken: "doc-token",
      }),
    ).toBe("duplicate");
  });

  it("classifies a paste from another document as external-paste", () => {
    const pasted = clipboardRoundTrip(
      attachCopyProvenance(makeContent(), "other-doc-token"),
    );
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(pasted),
        localDocumentToken: "doc-token",
      }),
    ).toBe("external-paste");
  });

  it("classifies an identical-snapshot sibling paste as external-paste", () => {
    // Two documents created from the same snapshot share EVERY id —
    // shape, frame, step, and track. Byte-identical content, different
    // source instance: only the token can (and does) tell them apart.
    const local = attachCopyProvenance(makeContent(), "doc-token");
    const sibling = attachCopyProvenance(makeContent(), "sibling-token");
    expect(JSON.stringify(makeContent())).toBe(JSON.stringify(makeContent()));
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(clipboardRoundTrip(local)),
        localDocumentToken: "doc-token",
      }),
    ).toBe("duplicate");
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(clipboardRoundTrip(sibling)),
        localDocumentToken: "doc-token",
      }),
    ).toBe("external-paste");
  });

  it("classifies content without provenance as external-paste (safe default)", () => {
    // Older anipres versions, other tldraw apps, or hand-crafted
    // payloads carry no token.
    expect(readCopyProvenance(clipboardRoundTrip(makeContent()))).toBeNull();
    expect(
      classifyRemapOperation({
        provenance: null,
        localDocumentToken: "doc-token",
      }),
    ).toBe("external-paste");
    expect(readCopyProvenance(null)).toBeNull();
    expect(
      readCopyProvenance({ [COPY_PROVENANCE_KEY]: "not-an-object" }),
    ).toBeNull();
  });

  it("classifies same-document cut+paste as duplicate (intended semantics)", () => {
    // tldraw's cut copies the content — stamping the token — and then
    // deletes the shapes, so a same-document cut+paste classifies as
    // duplicate: identities are freshened, and because the originals are
    // gone the placement pass keeps the source keys, so frames return to
    // their old positions with fresh identities. A CROSS-document
    // cut+paste has differing tokens → external-paste, which keeps
    // identities (move semantics).
    const cutContent = clipboardRoundTrip(
      attachCopyProvenance(makeContent(), "doc-token"),
    );
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(cutContent),
        localDocumentToken: "doc-token",
      }),
    ).toBe("duplicate");
    expect(
      classifyRemapOperation({
        provenance: readCopyProvenance(cutContent),
        localDocumentToken: "another-doc-token",
      }),
    ).toBe("external-paste");
  });
});
