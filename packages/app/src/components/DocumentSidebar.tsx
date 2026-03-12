import { useState } from "react";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import { DocumentListItem } from "./DocumentListItem";
import styles from "./DocumentSidebar.module.css";

export function DocumentSidebar() {
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
        className={styles.toggleButton}
        onClick={() => setCollapsed(false)}
        title="Show sidebar"
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
          <button className={styles.newButton} onClick={createDocument}>
            + New
          </button>
          <button
            className={styles.newButton}
            onClick={() => setCollapsed(true)}
            title="Hide sidebar"
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
    </div>
  );
}
