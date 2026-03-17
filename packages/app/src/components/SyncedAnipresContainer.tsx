import { useSync } from "@tldraw/sync";
import type { TLAssetStore } from "tldraw";
import { Anipres, allShapeUtils, allBindingUtils } from "anipres";

interface SyncedAnipresContainerProps {
  roomId: string;
  colorScheme?: "light" | "dark" | "system";
}

const remoteAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/assets", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`Asset upload failed: ${res.status}`);
    }
    const { key } = (await res.json()) as { key: string };
    return { src: `/api/assets/${key}` };
  },
  resolve(asset) {
    return asset.props.src;
  },
};

export function SyncedAnipresContainer({
  roomId,
  colorScheme,
}: SyncedAnipresContainerProps) {
  const store = useSync({
    uri: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/connect/${encodeURIComponent(roomId)}`,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
    assets: remoteAssetStore,
  });

  return <Anipres key={roomId} store={store} colorScheme={colorScheme} />;
}
