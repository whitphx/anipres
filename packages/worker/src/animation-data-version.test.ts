import { describe, expect, it } from "vitest";
import { SYNC_CLIENT_VERSION } from "anipres/models";
import {
  TLSyncErrorCloseEventCode,
  TLSyncErrorCloseEventReason,
} from "@tldraw/sync-core";
import {
  REQUIRED_SYNC_ANIMATION_DATA_VERSION,
  getAnimationDataVersionGateResponse,
} from "./animation-data-version";
import { connectRoutes } from "./routes/connect";
import { documentsRoutes } from "./routes/documents";

const documentId = "00000000-0000-4000-8000-000000000000";

describe("sync animation data version gate", () => {
  it("gates on the library's sync client version (single source of truth)", () => {
    expect(REQUIRED_SYNC_ANIMATION_DATA_VERSION).toBe(SYNC_CLIENT_VERSION);
  });

  it("rejects clients predating the media record vocabulary", async () => {
    // A build from before the youtube-embed/media-control records
    // declares 2: it would fail the store load on the unknown shape and
    // binding types, and offer to clear the mediaControl frames it
    // cannot parse.
    for (const suffix of [
      "",
      "?animationDataVersion=1",
      "?animationDataVersion=2",
    ]) {
      const response = getAnimationDataVersionGateResponse(
        new Request(`https://example.test/api/connect/document${suffix}`),
      );
      expect(response?.status).toBe(426);
      expect(await response?.json()).toEqual({
        error: "Animation data upgrade required",
        reason: "client-too-old",
        minimumVersion: REQUIRED_SYNC_ANIMATION_DATA_VERSION,
      });
    }
  });

  it("allows a client declaring this build's vocabulary", () => {
    expect(
      getAnimationDataVersionGateResponse(
        new Request(
          `https://example.test/api/connect/document?animationDataVersion=${SYNC_CLIENT_VERSION}`,
        ),
      ),
    ).toBeUndefined();
    expect(
      getAnimationDataVersionGateResponse(
        new Request("https://example.test/api/documents/document/snapshot", {
          headers: {
            "x-anipres-animation-data-version": String(SYNC_CLIENT_VERSION),
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a client ahead of this build, which would write records it cannot store", async () => {
    // The deploy window this closes: a newer app reaching a worker that
    // has no schema registration for the records it is about to write.
    const response = getAnimationDataVersionGateResponse(
      new Request(
        `https://example.test/api/connect/document?animationDataVersion=${SYNC_CLIENT_VERSION + 1}`,
      ),
    );
    expect(response?.status).toBe(426);
    expect(await response?.json()).toEqual({
      error: "Server animation data upgrade required",
      reason: "server-too-old",
      minimumVersion: REQUIRED_SYNC_ANIMATION_DATA_VERSION,
    });
  });

  it("closes a too-new sync upgrade with SERVER_TOO_OLD, not CLIENT_TOO_OLD", async () => {
    const connectResponse = await connectRoutes.request(
      `/api/connect/${documentId}?animationDataVersion=${SYNC_CLIENT_VERSION + 1}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(connectResponse.status).toBe(101);
    const ws = connectResponse.webSocket;
    const closeEvent = new Promise<CloseEvent>((resolve) => {
      ws!.addEventListener("close", (event) => resolve(event));
    });
    ws!.accept();
    const { code, reason } = await closeEvent;
    expect(code).toBe(TLSyncErrorCloseEventCode);
    // Telling this client it is too old would send the user to reload
    // into the bundle they are already running.
    expect(reason).toBe(TLSyncErrorCloseEventReason.SERVER_TOO_OLD);
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
    // REQUIRED_SYNC_ANIMATION_DATA_VERSION constant the app's shared
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
            REQUIRED_SYNC_ANIMATION_DATA_VERSION,
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
