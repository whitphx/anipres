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
  finalizeDeletingDocument,
  getReferencedDocumentAssetNames,
  isDocumentDeleting,
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

const DOCUMENT_DELETE_RETRY_MS = 30_000;

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
      this.ctx.waitUntil(this.ctx.storage.put("documentId", documentId));
    } catch {
      // Ignore malformed internal URLs; the route handler will reject them later.
    }
  }

  private async setDocumentId(documentId: string) {
    if (!documentId || documentId === this.documentId) {
      return;
    }

    this.documentId = documentId;
    this.lastSyncedAssetNamesJson = null;
    await this.ctx.storage.put("documentId", documentId);
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
      const reconciliation = this.syncReferencedAssets().catch((error) => {
        console.error("Failed to reconcile document assets", error);
      });
      this.ctx.waitUntil(reconciliation);
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

  private async runDocumentAssetGcCycle() {
    if (!this.documentId) {
      return;
    }

    // Snapshot reconciliation is debounced, but alarm-driven GC must observe
    // the latest live room state first so undo/redo does not delete a blob
    // that was just referenced again.
    if (this.room.getNumActiveSessions() > 0) {
      await this.syncReferencedAssets();
    }

    const nextGcAt = await runDocumentAssetGc(this.env, this.documentId);
    await this.scheduleAssetGcAlarm(nextGcAt);
  }

  private async runDeletePass() {
    if (!this.documentId) {
      return;
    }

    try {
      const deleted = await finalizeDeletingDocument(this.env, this.documentId);
      if (deleted) {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      console.error("Failed to finalize document deletion", error);
      await this.ctx.storage.setAlarm(Date.now() + DOCUMENT_DELETE_RETRY_MS);
    }
  }

  async scheduleAssetGc(documentId: string): Promise<void> {
    await this.setDocumentId(documentId);
    await this.runDocumentAssetGcCycle();
  }

  async startDelete(documentId: string): Promise<void> {
    await this.setDocumentId(documentId);
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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

    if (await isDocumentDeleting(this.env, this.documentId)) {
      await this.runDeletePass();
      return;
    }

    await this.runDocumentAssetGcCycle();
  }
}
