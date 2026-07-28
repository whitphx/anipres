import { describe, expect, it } from "vitest";
import { TIMELINE_FORMAT_VERSION } from "anipres/models";
import {
  MINIMUM_SYNC_ANIMATION_DATA_VERSION,
  getAnimationDataVersionGateResponse,
} from "./animation-data-version";
import { connectRoutes } from "./routes/connect";
import { documentsRoutes } from "./routes/documents";

const documentId = "00000000-0000-4000-8000-000000000000";

describe("sync animation data version gate", () => {
  it("gates on the library's timeline format version (single source of truth)", () => {
    expect(MINIMUM_SYNC_ANIMATION_DATA_VERSION).toBe(TIMELINE_FORMAT_VERSION);
  });


  it("rejects v1 clients and clients without a version", async () => {
    for (const suffix of ["", "?animationDataVersion=1"]) {
      const response = getAnimationDataVersionGateResponse(
        new Request(`https://example.test/api/connect/document${suffix}`),
      );
      expect(response?.status).toBe(426);
      expect(await response?.json()).toEqual({
        error: "Animation data upgrade required",
        minimumVersion: MINIMUM_SYNC_ANIMATION_DATA_VERSION,
      });
    }
  });

  it("allows v2 and later clients through to the sync handshake", () => {
    expect(
      getAnimationDataVersionGateResponse(
        new Request(
          "https://example.test/api/connect/document?animationDataVersion=2",
        ),
      ),
    ).toBeUndefined();
    expect(
      getAnimationDataVersionGateResponse(
        new Request(
          "https://example.test/api/connect/document?animationDataVersion=3",
        ),
      ),
    ).toBeUndefined();
    expect(
      getAnimationDataVersionGateResponse(
        new Request("https://example.test/api/documents/document/snapshot", {
          headers: { "x-anipres-animation-data-version": "2" },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects stale clients at the sync and snapshot route boundaries", async () => {
    const connectResponse = await connectRoutes.request(
      `/api/connect/${documentId}?animationDataVersion=1`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(connectResponse.status).toBe(426);

    const snapshotResponse = await documentsRoutes.request(
      `/api/documents/${documentId}/snapshot`,
      { method: "PUT" },
    );
    expect(snapshotResponse.status).toBe(426);
  });
});
