import { createContext, useContext } from "react";
import type { DocumentManager } from "./useDocumentManager";

export const DocumentManagerContext = createContext<DocumentManager | null>(
  null,
);

export function useDocumentManagerContext(): DocumentManager {
  const ctx = useContext(DocumentManagerContext);
  if (!ctx) {
    throw new Error(
      "useDocumentManagerContext must be used within DocumentManagerProvider",
    );
  }
  return ctx;
}
