const syncUserColors = ["#0f766e", "#2563eb", "#9333ea", "#d97706", "#dc2626"];

export function isSyncEnabled() {
  return import.meta.env.VITE_TLDRAW_SYNC_ENABLED === "true";
}

export function getSyncWorkerUrl() {
  const configuredBaseUrl = import.meta.env.VITE_TLDRAW_SYNC_WORKER_URL?.trim();
  if (!configuredBaseUrl) {
    throw new Error(
      "VITE_TLDRAW_SYNC_WORKER_URL is required when VITE_TLDRAW_SYNC_ENABLED=true.",
    );
  }

  const url = new URL(configuredBaseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(
      "VITE_TLDRAW_SYNC_WORKER_URL must use http:// or https://.",
    );
  }

  return url;
}

export function getSyncRoomUri(documentId: string) {
  const url = new URL(`/rooms/${documentId}`, getSyncWorkerUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createSyncUserInfo() {
  const index = Math.floor(Math.random() * syncUserColors.length);
  return {
    id: crypto.randomUUID(),
    name: `Guest ${Math.floor(Math.random() * 900) + 100}`,
    color: syncUserColors[index],
  };
}
