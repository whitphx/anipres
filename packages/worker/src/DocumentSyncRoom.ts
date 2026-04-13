import { type RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
import { createTLSchema, defaultShapeSchemas } from "tldraw";
import type { TLRecord, TLStoreSnapshot } from "tldraw";
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

function roomSnapshotToStoreSnapshot(snapshot: RoomSnapshot): TLStoreSnapshot {
  return {
    store: Object.fromEntries(
      snapshot.documents.map(({ state }) => [state.id, state as TLRecord]),
    ) as TLStoreSnapshot["store"],
    schema: snapshot.schema ?? schema.serialize(),
  };
}

export class DocumentSyncRoom extends DurableObject<WorkerEnv> {
  private room!: TLSocketRoom<TLRecord, void>;
  private documentId: string | null = null;
  private snapshotVersion = 0;
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
        "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, version INTEGER NOT NULL)",
      );

      this.documentId =
        (await this.ctx.storage.get<string>("documentId")) ?? null;

      let initialSnapshot: RoomSnapshot | undefined;
      const rows = ctx.storage.sql
        .exec("SELECT data, version FROM snapshot WHERE id = 1")
        .toArray();
      if (rows.length > 0) {
        try {
          initialSnapshot = JSON.parse(rows[0].data as string);
          this.snapshotVersion = Number(rows[0].version ?? 0);
        } catch (error) {
          console.error("Failed to parse stored snapshot; deleting corrupted row", error);
          ctx.storage.sql.exec("DELETE FROM snapshot WHERE id = 1");
          this.snapshotVersion = 0;
        }
      }

      // Intentionally not wrapped in try/catch: if room creation fails (e.g.
      // a transient schema bug), the DO should fail closed rather than delete
      // the snapshot row and silently replace it with an empty room.
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
    if (await this.isDeleting()) {
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

  private async isDeleting() {
    return this.documentId ? isDocumentDeleting(this.env, this.documentId) : false;
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
   * Write a room snapshot to SQLite. Uses the given snapshot or falls back to
   * the current room state. `ctx.storage.sql` ops are synchronous in the DO.
   */
  private flushSnapshot(snapshot?: RoomSnapshot, incrementVersion = false) {
    if (incrementVersion) {
      this.snapshotVersion += 1;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO snapshot (id, data, version) VALUES (1, ?, ?)",
      JSON.stringify(snapshot ?? this.room.getCurrentSnapshot()),
      this.snapshotVersion,
    );
    this.snapshotDirty = false;
    if (this.snapshotSaveTimer) {
      clearTimeout(this.snapshotSaveTimer);
      this.snapshotSaveTimer = null;
    }
  }

  private flushSnapshotIfDirty() {
    if (this.snapshotDirty) {
      this.flushSnapshot(undefined, true);
    }
  }

  /**
   * Fixed-window throttle: fires {@link SNAPSHOT_SAVE_DELAY_MS} after the
   * *first* change. Subsequent changes within the window do not reset the
   * timer, guaranteeing bounded persistence latency.
   */
  private scheduleSnapshotSave() {
    if (!this.documentId) return;
    this.snapshotDirty = true;
    if (this.snapshotSaveTimer) return;
    this.snapshotSaveTimer = setTimeout(() => {
      this.snapshotSaveTimer = null;
      const flushTask = this.runRoomTask(async () => {
        if (await this.isDeleting()) {
          return;
        }
        this.flushSnapshotIfDirty();
      }).catch(async (error) => {
        console.error("Failed to persist room snapshot", error);
        if (!(await this.isDeleting())) {
          this.scheduleSnapshotSave();
        }
      });
      this.ctx.waitUntil(flushTask);
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
    if (await this.isDeleting()) {
      return;
    }

    const snapshot = this.room.getCurrentSnapshot();
    if (this.snapshotDirty) {
      this.flushSnapshot(snapshot, true);
    }
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
        // Reset in-memory state so a warm DO doesn't serve stale data if the
        // same document UUID is re-created.
        this.documentId = null;
        this.snapshotVersion = 0;
        this.lastSyncedAssetNamesJson = null;
        this.snapshotDirty = false;
        this.room = this.createRoom();
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

  private cancelPendingSnapshotSave() {
    this.snapshotDirty = false;
    if (this.snapshotSaveTimer) {
      clearTimeout(this.snapshotSaveTimer);
      this.snapshotSaveTimer = null;
    }
  }

  private cancelPendingAssetSync() {
    if (this.assetSyncTimer) {
      clearTimeout(this.assetSyncTimer);
      this.assetSyncTimer = null;
    }
  }

  /**
   * Replace the room snapshot with a snapshot pushed by an offline client.
   * Returns `true` on success, `false` if the room currently has active
   * WebSocket sessions (which means live editing is in progress and overwriting
   * could clobber unsaved changes).
   *
   * The snapshot arrives as a deserialized JSON object via DO RPC, so the
   * concrete TS type is lost. `loadSnapshot` accepts both `RoomSnapshot` and
   * `TLStoreSnapshot` and will validate internally.
   */
  async replaceSnapshot(
    documentId: string,
    snapshot: unknown,
    expectedSnapshotVersion: number,
  ): Promise<{ replaced: boolean; snapshotVersion: number }> {
    await this.setDocumentId(documentId);
    return this.runRoomTask(async () => {
      this.flushSnapshotIfDirty();
      if (this.room.getNumActiveSessions() > 0) {
        return { replaced: false, snapshotVersion: this.snapshotVersion };
      }
      if (this.snapshotVersion !== expectedSnapshotVersion) {
        return { replaced: false, snapshotVersion: this.snapshotVersion };
      }
      this.room.loadSnapshot(snapshot as RoomSnapshot);
      this.cancelPendingAssetSync();
      this.cancelPendingSnapshotSave();
      this.flushSnapshot(undefined, true);
      await this.syncSnapshotAndReferencedAssets();
      return { replaced: true, snapshotVersion: this.snapshotVersion };
    });
  }

  async getCachedSnapshot(documentId: string): Promise<{
    // This crosses the DO RPC boundary. Keeping it as `unknown` avoids
    // forcing the full nested TLStoreSnapshot type through the stub/provider
    // machinery, which otherwise triggers TS2589 at the worker call site.
    snapshot: unknown;
    snapshotVersion: number;
  }> {
    await this.setDocumentId(documentId);
    return this.runRoomTask(async () => {
      if (!(await this.isDeleting())) {
        this.flushSnapshotIfDirty();
      }
      return {
        snapshot: roomSnapshotToStoreSnapshot(this.room.getCurrentSnapshot()),
        snapshotVersion: this.snapshotVersion,
      };
    });
  }

  async startDelete(documentId: string): Promise<void> {
    await this.setDocumentId(documentId);
    await this.runRoomTask(async () => {
      // Delete owns the document lifecycle from here. Drop any pending asset
      // reconcile timer so it cannot do unnecessary snapshot/asset work while
      // the document is already in its retryable deleting state.
      this.cancelPendingAssetSync();
      // Cancel any pending save so it cannot re-insert the row after deletion.
      this.cancelPendingSnapshotSave();
      // Preserve any in-progress cursor so repeated DELETE requests or retries do
      // not restart the R2 prefix sweep from the beginning.
      await this.ctx.storage.setAlarm(Date.now());
      // Clear the snapshot only after the alarm is durably scheduled so a failed
      // startDelete call cannot leave an active document without its snapshot.
      this.ctx.storage.sql.exec("DELETE FROM snapshot WHERE id = 1");
    });
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
