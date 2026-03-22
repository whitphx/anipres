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
  getReferencedDocumentAssetNames,
  reconcileDocumentAssets,
  runDocumentAssetGc,
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
  private lastSyncedAssetNamesJson: string | null = null;
  private assetSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.documentId =
        (await this.ctx.storage.get<string>("documentId")) ?? null;
    });
    this.room = this.createRoom();
  }

  private createRoom() {
    // Phase 1 POC: no persistence — data lives only while the DO is active.
    // A future phase will add SQLite-backed persistence.
    return new TLSocketRoom<TLRecord, void>({
      schema,
      onDataChange: () => {
        this.scheduleAssetSync();
      },
    });
  }

  private setDocumentIdFromRequest(request: Request) {
    try {
      const documentId = decodeURIComponent(
        new URL(request.url).pathname.split("/").pop() ?? "",
      );
      if (!documentId || documentId === this.documentId) {
        return;
      }

      this.documentId = documentId;
      this.lastSyncedAssetNamesJson = null;
      void this.ctx.storage.put("documentId", documentId);
    } catch {
      // Ignore malformed internal URLs; the route handler will reject them later.
    }
  }

  private async scheduleAssetGcAlarm(nextGcAt: number | null) {
    if (nextGcAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextGcAt);
  }

  private scheduleAssetSync() {
    if (!this.documentId) {
      return;
    }

    if (this.assetSyncTimer) {
      clearTimeout(this.assetSyncTimer);
    }

    this.assetSyncTimer = setTimeout(() => {
      this.assetSyncTimer = null;
      void this.syncReferencedAssets().catch((error) => {
        console.error("Failed to reconcile document assets", error);
      });
    }, 500);
  }

  private async syncReferencedAssets() {
    if (!this.documentId) {
      return;
    }

    const assetNames = getReferencedDocumentAssetNames(
      this.room.getCurrentSnapshot(),
      this.documentId,
    );
    const nextAssetNamesJson = JSON.stringify(assetNames);
    if (nextAssetNamesJson === this.lastSyncedAssetNamesJson) {
      return;
    }

    const nextGcAt = await reconcileDocumentAssets(
      this.env,
      this.documentId,
      assetNames,
    );
    this.lastSyncedAssetNamesJson = nextAssetNamesJson;
    await this.scheduleAssetGcAlarm(nextGcAt);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.startsWith("/internal/")) {
      this.setDocumentIdFromRequest(request);
      if (!this.documentId) {
        return new Response("Missing documentId", { status: 400 });
      }

      const nextGcAt = await runDocumentAssetGc(this.env, this.documentId);
      await this.scheduleAssetGcAlarm(nextGcAt);
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

  override async alarm(): Promise<void> {
    if (!this.documentId) {
      this.documentId =
        (await this.ctx.storage.get<string>("documentId")) ?? null;
    }
    if (!this.documentId) {
      return;
    }

    const nextGcAt = await runDocumentAssetGc(this.env, this.documentId);
    await this.scheduleAssetGcAlarm(nextGcAt);
  }
}
