import type { Context } from "hono";
import type { DocumentSyncRoom } from "./DocumentSyncRoom";

export interface Env {
  DOCUMENT_SYNC_ROOM: DurableObjectNamespace<DocumentSyncRoom>;
  DB: D1Database;
  GITHUB_ID: string;
  GITHUB_SECRET: string;
  GOOGLE_ID: string;
  GOOGLE_SECRET: string;
  JWT_SECRET: string;
  ASSETS: R2Bucket;
}

export type Variables = {
  userId: number;
};

export type AppBindings = {
  Bindings: Env;
  Variables: Variables;
};

export type AppContext = Context<AppBindings>;
