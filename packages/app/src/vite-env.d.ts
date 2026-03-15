/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TLDRAW_SYNC_ENABLED?: string;
  readonly VITE_TLDRAW_SYNC_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
