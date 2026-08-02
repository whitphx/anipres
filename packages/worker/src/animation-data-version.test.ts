import { describe, expect, it } from "vitest";
import { TIMELINE_FORMAT_VERSION } from "anipres/models";
import {
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
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

  it("rejects a stale sync upgrade IN-PROTOCOL with CLIENT_TOO_OLD", async () => {
    // The rejection must ride the accepted socket's close frame: an HTTP
    // status returned before the upgrade reaches the client as an opaque
    // 1006, which tldraw's sync client treats as a transient network
    // failure and retries forever instead of surfacing an error state.
    const connectResponse = await connectRoutes.request(
      `/api/connect/${documentId}?animationDataVersion=1`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(connectResponse.status).toBe(101);
    const ws = connectResponse.webSocket;
    expect(ws).not.toBeNull();
    const closeEvent = new Promise<CloseEvent>((resolve) => {
      ws!.addEventListener("close", (event) => resolve(event));
    });
    ws!.accept();
    const { code, reason } = await closeEvent;
    expect(code).toBe(TLSyncErrorCloseEventCode);
    expect(reason).toBe(TLSyncErrorCloseEventReason.CLIENT_TOO_OLD);
  });

  it("rejects stale non-upgrade requests with HTTP 426", async () => {
    const connectResponse = await connectRoutes.request(
      `/api/connect/${documentId}?animationDataVersion=1`,
    );
    expect(connectResponse.status).toBe(426);

    const snapshotResponse = await documentsRoutes.request(
      `/api/documents/${documentId}/snapshot`,
      { method: "PUT" },
    );
    expect(snapshotResponse.status).toBe(426);
  });

  it("passes a snapshot PUT that declares the version, as the app's putSnapshot helper does", async () => {
    // Proves the GATE MIDDLEWARE admits a request carrying the current
    // version header (stringified from the same
    // MINIMUM_SYNC_ANIMATION_DATA_VERSION constant the app's shared
    // snapshot client uses). The app-side request shape itself —
    // content type, client id, version header — is pinned by
    // packages/app/src/documents/snapshot-push.test.ts against the
    // real hono client.
    const withHeader = await documentsRoutes.request(
      `/api/documents/${documentId}/snapshot`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-anipres-animation-data-version": String(
            MINIMUM_SYNC_ANIMATION_DATA_VERSION,
          ),
        },
        body: JSON.stringify({
          snapshot: { store: {}, schema: {} },
          expectedSnapshotVersion: 0,
        }),
      },
    );
    // Past the gate the route needs live bindings this test does not
    // provide, so any status except 426 proves the gate admitted the
    // request; the same request WITHOUT the header is rejected above.
    expect(withHeader.status).not.toBe(426);

    const stale = await documentsRoutes.request(
      `/api/documents/${documentId}/snapshot`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-anipres-animation-data-version": "1",
        },
        body: JSON.stringify({
          snapshot: { store: {}, schema: {} },
          expectedSnapshotVersion: 0,
        }),
      },
    );
    expect(stale.status).toBe(426);
  });
});
