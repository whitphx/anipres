import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { Anipres } from "anipres";
import type { TLStoreSnapshot } from "tldraw";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";

type AnipresOnMount = NonNullable<ComponentProps<typeof Anipres>["onMount"]>;

interface AnipresContainerProps {
  documentId: string;
  snapshot: TLStoreSnapshot | null;
}

export function AnipresContainer({
  documentId,
  snapshot,
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
    />
  );
}
