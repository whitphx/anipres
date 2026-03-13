import { useMemo } from "react";
import { useSync } from "@tldraw/sync";
import { defaultShapeUtils, defaultBindingUtils } from "tldraw";
import type { TLAssetStore } from "tldraw";
import { Anipres, customShapeUtils } from "anipres";

interface SyncedAnipresContainerProps {
  roomId: string;
  colorScheme?: "light" | "dark" | "system";
}

const WORKER_URL =
  import.meta.env.VITE_SYNC_WORKER_URL ?? "http://localhost:8787";

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
  const allShapeUtils = useMemo(
    () => [...defaultShapeUtils, ...customShapeUtils],
    [],
  );
  const allBindingUtils = useMemo(() => [...defaultBindingUtils], []);

  const store = useSync({
    uri: `${WORKER_URL}/api/connect/${roomId}`,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
    assets: inlineAssetStore,
  });

  return <Anipres key={roomId} store={store} colorScheme={colorScheme} />;
}
