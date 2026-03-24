import { type RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
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
const DOCUMENT_DELETE_CURSOR_STORAGE_KEY = "documentDeleteCursor";
const SNAPSHOT_SAVE_DELAY_MS = 3_000;

export class DocumentSyncRoom extends DurableObject<WorkerEnv> {
  private room!: TLSocketRoom<TLRecord, void>;
  private documentId: string | null = null;
  private lastSyncedAssetNamesJson: string | null = null;
  private assetSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotDirty = false;
  private roomTask: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // Ensure the SQLite snapshot table exists.
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
      );

      this.documentId =
        (await this.ctx.storage.get<string>("documentId")) ?? null;

      let initialSnapshot: RoomSnapshot | undefined;
      const rows = ctx.storage.sql
        .exec("SELECT data FROM snapshot WHERE id = 1")
        .toArray();
      if (rows.length > 0) {
        initialSnapshot = JSON.parse(rows[0].data as string);
      }

      this.room = this.createRoom(initialSnapshot);
    });
  }

  private createRoom(initialSnapshot?: RoomSnapshot) {
    return new TLSocketRoom<TLRecord, void>({
      schema,
      initialSnapshot,
      onDataChange: () => {
        this.scheduleAssetSync();
        this.scheduleSnapshotSave();
      },
      onSessionRemoved: (_room, { numSessionsRemaining }) => {
        if (numSessionsRemaining !== 0 || !this.documentId) {
          return;
        }

        const flushTask = this.runRoomTask(() =>
          this.syncSnapshotAndReferencedAssets(),
        ).catch((error) => {
          console.error("Failed to flush room snapshot after last disconnect", error);
        });
        this.ctx.waitUntil(flushTask);
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
    if (this.documentId && (await isDocumentDeleting(this.env, this.documentId))) {
      // Document deletion owns the single DO alarm slot until final cleanup
      // finishes. Once `deleting_at` is set, asset-GC reconciles must not
      // clear or push out that delete retry schedule.
      return;
    }

    if (nextGcAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextGcAt);
  }

  private runRoomTask<T>(task: () => Promise<T>) {
    const run = this.roomTask.then(task, task);
    this.roomTask = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Write the current room snapshot to SQLite.
   * `ctx.storage.sql` operations are synchronous within the DO isolate.
   */
  private flushSnapshot() {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO snapshot (id, data) VALUES (1, ?)",
      JSON.stringify(this.room.getCurrentSnapshot()),
    );
    this.snapshotDirty = false;
    if (this.snapshotSaveTimer) {
      clearTimeout(this.snapshotSaveTimer);
      this.snapshotSaveTimer = null;
    }
  }

  /**
   * Trailing-edge throttle: fires {@link SNAPSHOT_SAVE_DELAY_MS} after the
   * *first* change. Subsequent changes within the window do not reset the
   * timer, guaranteeing bounded persistence latency.
   */
  private scheduleSnapshotSave() {
    this.snapshotDirty = true;
    if (this.snapshotSaveTimer) return;
    this.snapshotSaveTimer = setTimeout(() => {
      this.snapshotSaveTimer = null;
      if (this.snapshotDirty) {
        this.flushSnapshot();
      }
    }, SNAPSHOT_SAVE_DELAY_MS);
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
      const syncTask = this.runRoomTask(() =>
        this.syncSnapshotAndReferencedAssets(),
      ).catch((error) => {
        console.error("Failed to sync room snapshot and document assets", error);
      });
      this.ctx.waitUntil(syncTask);
    }, 500);
  }

  private async syncSnapshotAndReferencedAssets() {
    if (!this.documentId) {
      return;
    }

    this.flushSnapshot();

    const snapshot = this.room.getCurrentSnapshot();
    const assetNames = getReferencedDocumentAssetNames(snapshot, this.documentId);
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

    // The room snapshot is now restored from DO storage on startup, so it is
    // authoritative enough to reconcile before GC even when no sockets are
    // currently attached. That closes the "upload then quick disconnect"
    // window where a referenced asset could otherwise stay stale forever.
    await this.syncSnapshotAndReferencedAssets();

    const nextGcAt = await runDocumentAssetGc(this.env, this.documentId);
    await this.scheduleAssetGcAlarm(nextGcAt);
  }

  private async runDocumentDeleteCycle() {
    if (!this.documentId) {
      return;
    }

    try {
      const cursor =
        (await this.ctx.storage.get<string>(DOCUMENT_DELETE_CURSOR_STORAGE_KEY)) ??
        undefined;
      const { completed, nextCursor } = await finalizeDeletingDocument(
        this.env,
        this.documentId,
        cursor,
      );
      if (completed) {
        await this.ctx.storage.delete(DOCUMENT_DELETE_CURSOR_STORAGE_KEY);
        this.ctx.storage.sql.exec("DELETE FROM snapshot WHERE id = 1");
        await this.ctx.storage.delete("documentId");
        await this.ctx.storage.deleteAlarm();
        return;
      }

      if (!nextCursor) {
        throw new Error("Expected a delete cursor for incomplete document deletion");
      }
      await this.ctx.storage.put(DOCUMENT_DELETE_CURSOR_STORAGE_KEY, nextCursor);
      await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      console.error("Failed to finalize document deletion", error);
      await this.ctx.storage.setAlarm(Date.now() + DOCUMENT_DELETE_RETRY_MS);
    }
  }

  async scheduleAssetGc(documentId: string): Promise<void> {
    await this.setDocumentId(documentId);
    await this.runRoomTask(() => this.runDocumentAssetGcCycle());
  }

  async startDelete(documentId: string): Promise<void> {
    await this.setDocumentId(documentId);
    // Clear the snapshot so a re-created document doesn't inherit stale state.
    this.ctx.storage.sql.exec("DELETE FROM snapshot WHERE id = 1");
    // Preserve any in-progress cursor so repeated DELETE requests or retries do
    // not restart the R2 prefix sweep from the beginning.
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
      await this.runRoomTask(() => this.runDocumentDeleteCycle());
      return;
    }

    await this.runRoomTask(() => this.runDocumentAssetGcCycle());
  }
}
