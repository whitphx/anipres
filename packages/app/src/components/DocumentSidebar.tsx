import { useState } from "react";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import type { ColorSchemePreference } from "../hooks/useColorScheme";
import { ColorSchemeSwitcher } from "./ColorSchemeSwitcher";
import { DocumentListItem } from "./DocumentListItem";
import styles from "./DocumentSidebar.module.css";

interface DocumentSidebarProps {
  colorSchemePreference: ColorSchemePreference;
  onColorSchemeChange: (next: ColorSchemePreference) => void;
}

export function DocumentSidebar({
  colorSchemePreference,
  onColorSchemeChange,
}: DocumentSidebarProps) {
  const {
    documents,
    activeDocumentId,
    selectDocument,
    createDocument,
    deleteDocument,
    renameDocument,
  } = useDocumentManagerContext();

  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setCollapsed(false)}
        title="Show sidebar"
        aria-label="Show sidebar"
      >
        ☰
      </button>
    );
  }

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Documents</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className={styles.newButton}
            onClick={createDocument}
          >
            + New
          </button>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => setCollapsed(true)}
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            ◀
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {documents.map((doc) => (
          <DocumentListItem
            key={doc.id}
            doc={doc}
            isActive={doc.id === activeDocumentId}
            onSelect={selectDocument}
            onRename={renameDocument}
            onDelete={deleteDocument}
          />
        ))}
      </div>
      <ColorSchemeSwitcher
        preference={colorSchemePreference}
        onChange={onColorSchemeChange}
      />
    </div>
  );
}
