import {
  Github,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  Plus,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useDocumentManagerContext } from "../documents/useDocumentManagerContext";
import type { DocumentMeta } from "../documents/types";
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

  const { user, loginWithGitHub, loginWithGoogle, logout } = useAuth();

  const [collapsed, setCollapsed] = useState(false);

  const { syncedDocs, localDocs } = useMemo(() => {
    const synced: DocumentMeta[] = [];
    const local: DocumentMeta[] = [];
    for (const doc of documents) {
      (doc.origin === "synced" ? synced : local).push(doc);
    }
    return { syncedDocs: synced, localDocs: local };
  }, [documents]);

  const showGroupHeaders = syncedDocs.length > 0 && localDocs.length > 0;

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setCollapsed(false)}
        title="Show sidebar"
        aria-label="Show sidebar"
      >
        <Menu size={16} />
      </button>
    );
  }

  const renderGroup = (docs: DocumentMeta[]) =>
    docs.map((doc) => (
      <DocumentListItem
        key={doc.id}
        doc={doc}
        isActive={doc.id === activeDocumentId}
        onSelect={selectDocument}
        onRename={renameDocument}
        onDelete={deleteDocument}
      />
    ));

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Documents</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => createDocument()}
          >
            <Plus size={14} /> New
          </button>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => setCollapsed(true)}
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {showGroupHeaders && syncedDocs.length > 0 && (
          <div className={styles.groupHeader}>Synced</div>
        )}
        {renderGroup(syncedDocs)}
        {showGroupHeaders && localDocs.length > 0 && (
          <div className={styles.groupHeader}>Local</div>
        )}
        {renderGroup(localDocs)}
      </div>
      <div className={styles.footer}>
        {user ? (
          <button type="button" className={styles.authButton} onClick={logout}>
            <LogOut size={14} /> Log out
          </button>
        ) : (
          <>
            <button
              type="button"
              className={styles.authButton}
              onClick={loginWithGitHub}
            >
              <Github size={14} /> Log in with GitHub
            </button>
            <button
              type="button"
              className={styles.authButton}
              onClick={loginWithGoogle}
            >
              <LogIn size={14} /> Log in with Google
            </button>
          </>
        )}
        <ColorSchemeSwitcher
          preference={colorSchemePreference}
          onChange={onColorSchemeChange}
        />
      </div>
    </div>
  );
}
