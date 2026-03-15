import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from "react";
import { useSync } from "@tldraw/sync";
import { Anipres, anipresSchema } from "anipres";
import type { TLStoreSnapshot } from "tldraw";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import {
  createSyncUserInfo,
  getSyncRoomUri,
  isSyncEnabled,
} from "../sync/config";
import styles from "./AnipresContainer.module.css";

type AnipresOnMount = NonNullable<ComponentProps<typeof Anipres>["onMount"]>;

interface AnipresContainerProps {
  documentId: string;
  snapshot: TLStoreSnapshot | null;
  colorScheme?: "light" | "dark" | "system";
}

const syncAssetStore: Parameters<typeof useSync>[0]["assets"] = {
  upload: async (_asset, file) => {
    const src = await fileToDataUrl(file);
    return { src };
  },
  resolve: (asset) => asset.props.src ?? null,
};

export function AnipresContainer({
  documentId,
  snapshot,
  colorScheme,
}: AnipresContainerProps) {
  if (isSyncEnabled()) {
    return (
      <SyncedAnipresContainer
        documentId={documentId}
        colorScheme={colorScheme}
      />
    );
  }

  return (
    <LocalAnipresContainer
      documentId={documentId}
      snapshot={snapshot}
      colorScheme={colorScheme}
    />
  );
}

function LocalAnipresContainer({
  documentId,
  snapshot,
  colorScheme,
}: AnipresContainerProps) {
  const { registerEditor } = useDocumentManagerContext();
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleMount = useCallback<AnipresOnMount>(
    (editor) => {
      cleanupRef.current = registerEditor(editor);
    },
    [registerEditor],
  );

  return (
    <Anipres
      key={documentId}
      snapshot={snapshot ?? undefined}
      onMount={handleMount}
      colorScheme={colorScheme}
    />
  );
}

function SyncedAnipresContainer({
  documentId,
  colorScheme,
}: Pick<AnipresContainerProps, "documentId" | "colorScheme">) {
  const syncConfig = useMemo(() => {
    try {
      return { ok: true as const, roomUri: getSyncRoomUri(documentId) };
    } catch (error) {
      return {
        ok: false as const,
        error:
          error instanceof Error
            ? error
            : new Error("Failed to configure sync worker URL."),
      };
    }
  }, [documentId]);

  if (!syncConfig.ok) {
    return (
      <MessagePanel
        title="Sync is enabled but misconfigured."
        body={syncConfig.error.message}
        code="Set VITE_TLDRAW_SYNC_WORKER_URL and restart the app dev server."
        role="alert"
      />
    );
  }

  return (
    <SyncedAnipresEditor
      documentId={documentId}
      roomUri={syncConfig.roomUri}
      colorScheme={colorScheme}
    />
  );
}

function MessagePanel({
  title,
  body,
  code,
  role,
}: {
  title: string;
  body: string;
  code?: string;
  role?: "alert";
}) {
  return (
    <div className={styles.messagePanel} role={role}>
      <div className={styles.messageCard}>
        <p className={styles.messageTitle}>{title}</p>
        <p className={styles.messageBody}>
          {body}
          {code ? <span className={styles.messageCode}>{code}</span> : null}
        </p>
      </div>
    </div>
  );
}

function SyncedAnipresEditor({
  documentId,
  roomUri,
  colorScheme,
}: {
  documentId: string;
  roomUri: string;
  colorScheme?: "light" | "dark" | "system";
}) {
  const { registerEditor } = useDocumentManagerContext();
  const cleanupRef = useRef<(() => void) | null>(null);

  const userInfo = useMemo(() => createSyncUserInfo(), []);

  const syncedStore = useSync({
    uri: roomUri,
    userInfo,
    assets: syncAssetStore,
    schema: anipresSchema,
  });

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleMount = useCallback<AnipresOnMount>(
    (editor) => {
      cleanupRef.current = registerEditor(editor);
    },
    [registerEditor],
  );

  if (syncedStore.status === "loading") {
    return (
      <MessagePanel
        title="Connecting to sync worker..."
        body="The editor will appear as soon as the initial room handshake completes."
        code={roomUri}
      />
    );
  }

  if (syncedStore.status === "error") {
    return (
      <MessagePanel
        title="Failed to connect to the sync worker."
        body={syncedStore.error.message}
        code={roomUri}
        role="alert"
      />
    );
  }

  return (
    <div className={styles.syncedRoot}>
      <div className={styles.statusBadge}>
        <span
          className={`${styles.statusDot} ${
            syncedStore.connectionStatus === "offline"
              ? styles.statusDotOffline
              : ""
          }`}
        />
        {syncedStore.connectionStatus === "offline"
          ? "Sync offline"
          : "Sync online"}
      </div>
      <Anipres
        key={documentId}
        store={syncedStore.store}
        onMount={handleMount}
        colorScheme={colorScheme}
      />
    </div>
  );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read asset file"));
    };
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Expected a data URL string"));
    };

    reader.readAsDataURL(file);
  });
}
