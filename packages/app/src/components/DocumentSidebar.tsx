import { Github, LogOut, Menu, PanelLeftClose, Plus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
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

  const { user, loginWithGitHub, loginWithGoogle, logout } = useAuth();

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
        <Menu size={16} />
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
              Log in with Google
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
