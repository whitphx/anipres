import { useSync } from "@tldraw/sync";
import type { TLAssetStore } from "tldraw";
import { Anipres, customShapeUtils } from "anipres";

const noopAssetStore: TLAssetStore = {
  upload: async () => ({ src: "" }),
  resolve: (asset) => asset.props.src,
};

interface SyncedAnipresContainerProps {
  roomId: string;
  serverBaseUrl: string;
  colorScheme?: "light" | "dark" | "system";
}

export function SyncedAnipresContainer({
  roomId,
  serverBaseUrl,
  colorScheme,
}: SyncedAnipresContainerProps) {
  const store = useSync({
    uri: `${serverBaseUrl}/api/rooms/${roomId}`,
    assets: noopAssetStore,
    shapeUtils: customShapeUtils,
  });

  if (store.status === "loading") {
    return <div>Connecting to room...</div>;
  }

  if (store.status === "error") {
    return <div>Error connecting to room: {store.error.message}</div>;
  }

  return <Anipres store={store} colorScheme={colorScheme} />;
}
