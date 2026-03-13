import { useSync } from "@tldraw/sync";
import type { TLAssetStore } from "tldraw";
import { Anipres, allShapeUtils, allBindingUtils } from "anipres";

interface SyncedAnipresContainerProps {
  roomId: string;
  colorScheme?: "light" | "dark" | "system";
}

// POC: store images as inline data URLs. Not suitable for production.
const inlineAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { src: dataUrl };
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
    assets: inlineAssetStore,
  });

  return <Anipres key={roomId} store={store} colorScheme={colorScheme} />;
}
