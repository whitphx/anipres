import { TLSocketRoom } from "@tldraw/sync-core";
import { createTLSchema, defaultShapeSchemas } from "tldraw";
import type { TLRecord } from "tldraw";
import { DurableObject } from "cloudflare:workers";
import {
  slideShapeProps,
  SlideShapeType,
  themeImageShapeProps,
  ThemeImageShapeType,
} from "anipres/schema";
import {
  getDocumentOwnerUserId,
  getManagedAssetKeysFromValue,
  reconcileDocumentAssetRefs,
} from "./assets";
import type { Env as WorkerEnv } from "./types";

const schema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [SlideShapeType]: { props: slideShapeProps },
    [ThemeImageShapeType]: { props: themeImageShapeProps },
  },
});

export class DocumentSyncRoom extends DurableObject<WorkerEnv> {
  private room: TLSocketRoom<TLRecord, void>;
  private documentId: string | null = null;
  private lastSyncedAssetKeysJson = "[]";
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    // Phase 1 POC: no persistence — data lives only while the DO is active.
    // A future phase will add SQLite-backed persistence.
    this.room = new TLSocketRoom<TLRecord, void>({
      schema,
      onDataChange: () => {
        this.scheduleAssetRefSync();
      },
    });
  }

  private setDocumentIdFromRequest(request: Request) {
    const roomId = decodeURIComponent(
      new URL(request.url).pathname.split("/").pop() ?? "",
    );
    if (!roomId) {
      return;
    }

    if (this.documentId === roomId) {
      return;
    }

    this.documentId = roomId;
    this.scheduleAssetRefSync();
  }

  private scheduleAssetRefSync() {
    if (!this.documentId) {
      return;
    }

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncAssetRefs();
    }, 500);
  }

  private async syncAssetRefs() {
    if (!this.documentId) {
      return;
    }

    const userId = await getDocumentOwnerUserId(this.env, this.documentId);
    if (userId === null) {
      return;
    }

    const assetKeys = getManagedAssetKeysFromValue(
      this.room.getCurrentSnapshot(),
    );
    const nextAssetKeysJson = JSON.stringify(assetKeys);
    if (nextAssetKeysJson === this.lastSyncedAssetKeysJson) {
      return;
    }

    await reconcileDocumentAssetRefs(this.env, userId, this.documentId, assetKeys);
    this.lastSyncedAssetKeysJson = nextAssetKeysJson;
  }

  override async fetch(request: Request): Promise<Response> {
    this.setDocumentIdFromRequest(request);

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    this.room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }
}
