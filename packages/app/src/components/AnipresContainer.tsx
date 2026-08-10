import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { Anipres } from "anipres";
import { MAX_ASSET_SIZE } from "anipres-worker/tldraw-asset-policy";
import type { TLStoreSnapshot } from "tldraw";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";

type AnipresOnMount = NonNullable<ComponentProps<typeof Anipres>["onMount"]>;

interface AnipresContainerProps {
  documentId: string;
  snapshot: TLStoreSnapshot | null;
  colorScheme?: "light" | "dark" | "system";
}

export function AnipresContainer({
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
      // A local document with no sync behind it, so the cleanup that
      // needs a whole-document view is safe here.
      soleWriter
      onMount={handleMount}
      colorScheme={colorScheme}
      maxAssetSize={MAX_ASSET_SIZE}
    />
  );
}
