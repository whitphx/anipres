import { useContext } from "react";
import type { DocumentManager } from "./useDocumentManager";
import { DocumentManagerContext } from "./DocumentManagerContext";

export function useDocumentManagerContext(): DocumentManager {
  const ctx = useContext(DocumentManagerContext);
  if (!ctx) {
    throw new Error(
      "useDocumentManagerContext must be used within DocumentManagerProvider",
    );
  }
  return ctx;
}
