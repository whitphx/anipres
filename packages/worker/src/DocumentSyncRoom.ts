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
  getManagedAssetKeysFromSnapshot,
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

const DOCUMENT_ID_STORAGE_KEY = "documentId";

export class DocumentSyncRoom extends DurableObject<WorkerEnv> {
  private room: TLSocketRoom<TLRecord, void>;
  private documentId: string | null = null;
  private lastSyncedAssetKeysJson: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.documentId =
        (await ctx.storage.get<string>(DOCUMENT_ID_STORAGE_KEY)) ?? null;
    });
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
    this.lastSyncedAssetKeysJson = null;
    this.ctx.waitUntil(this.ctx.storage.put(DOCUMENT_ID_STORAGE_KEY, roomId));
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

  private async syncAssetRefs(force = false) {
    if (!this.documentId) {
      return;
    }

    const userId = await getDocumentOwnerUserId(this.env, this.documentId);
    if (userId === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const assetKeys = getManagedAssetKeysFromSnapshot(
      this.room.getCurrentSnapshot(),
    );
    const nextAssetKeysJson = JSON.stringify(assetKeys);
    if (
      !force &&
      this.lastSyncedAssetKeysJson !== null &&
      nextAssetKeysJson === this.lastSyncedAssetKeysJson
    ) {
      return;
    }

    const { nextGcAt } = await reconcileDocumentAssetRefs(
      this.env,
      userId,
      this.documentId,
      assetKeys,
    );
    this.lastSyncedAssetKeysJson = nextAssetKeysJson;
    await this.syncGcAlarm(nextGcAt);
  }

  private async syncGcAlarm(nextGcAt: number | null) {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (nextGcAt === null) {
      if (currentAlarm !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    if (currentAlarm === null || currentAlarm > nextGcAt) {
      await this.ctx.storage.setAlarm(nextGcAt);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/reconcile-assets") {
      const documentId = url.searchParams.get("documentId");
      if (!documentId) {
        return new Response("Missing documentId", { status: 400 });
      }

      if (this.documentId !== documentId) {
        this.documentId = documentId;
        this.lastSyncedAssetKeysJson = null;
        await this.ctx.storage.put(DOCUMENT_ID_STORAGE_KEY, documentId);
      }

      await this.syncAssetRefs(true);
      return new Response(null, { status: 204 });
    }

    this.setDocumentIdFromRequest(request);

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }

    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    this.room.handleSocketConnect({ sessionId, socket: serverWebSocket });

    return new Response(null, { status: 101, webSocket: clientWebSocket });
  }

  override async alarm() {
    await this.syncAssetRefs(true);
  }
}
